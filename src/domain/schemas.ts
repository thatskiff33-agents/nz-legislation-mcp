/**
 * Zod schemas for everything that crosses a trust boundary.
 *
 * Inputs (tool arguments) are strict: exact enums, bounded lengths, and cross-field rules,
 * because the API silently ignores invalid filters and would otherwise return misleading
 * "no results" answers.
 *
 * API responses are parsed tolerantly ("tolerant reader"): unknown fields are stripped and
 * enum-like fields are plain strings, so a new value from PCO does not break every tool.
 * Vocabulary drift is detected separately by contract tests against the live API.
 */
import { z } from "zod";
import { parseVersionId, parseWorkId, MAX_ID_LENGTH } from "./ids.js";
import {
  ACT_STATUSES,
  ACT_TYPES,
  BILL_STATUSES,
  BILL_TYPES,
  CLASSIFICATIONS,
  INSTRUMENT_STATUSES,
  INSTRUMENT_TYPE_GROUPS,
  LEGISLATION_STATUSES,
  LEGISLATION_TYPES,
  PUBLISHERS,
  SEARCH_FIELDS,
  SORT_ORDERS,
  TYPE_SPECIFIC_FILTERS,
  VERSION_SORTS,
} from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Identifier input schemas
// ---------------------------------------------------------------------------

export const WorkIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ID_LENGTH)
  .superRefine((value, ctx) => {
    const result = parseWorkId(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
  })
  .describe("Work identifier, e.g. act_public_2007_97 (Income Tax Act 2007).");

export const VersionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ID_LENGTH)
  .superRefine((value, ctx) => {
    const result = parseVersionId(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
  })
  .describe("Version identifier, e.g. act_public_2007_97_en_2025-05-29.");

// ---------------------------------------------------------------------------
// Search input schema
// ---------------------------------------------------------------------------

/** Maximum search term length. The API uses Elasticsearch simple query string syntax. */
export const MAX_SEARCH_TERM_LENGTH = 500;
/** Agency names must match the website's "browse agencies" list exactly. */
export const MAX_AGENCY_LENGTH = 200;
/** API maximum page size. */
export const MAX_PER_PAGE = 100;
/** Guard against pathological page numbers. */
export const MAX_PAGE = 10_000;

/**
 * Flat object (no root-level union) because several MCP clients mishandle `oneOf`/`anyOf`
 * at the root of a tool input schema. Cross-field rules are enforced in `superRefine`.
 */
export const SearchParamsSchema = z
  .object({
    search_term: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SEARCH_TERM_LENGTH)
      .optional()
      .describe(
        "Words to search for. Stemming is on (levy matches levies); wrap a word or phrase in double quotes for an exact match. Omit to browse by filters alone.",
      ),
    search_field: z
      .enum(SEARCH_FIELDS)
      .optional()
      .describe("Search titles only, or the full content. Defaults to the API's behaviour."),
    legislation_type: z.enum(LEGISLATION_TYPES).optional(),
    legislation_status: z.enum(LEGISLATION_STATUSES).optional(),
    act_type: z.enum(ACT_TYPES).optional().describe("Only with legislation_type=act."),
    act_status: z.enum(ACT_STATUSES).optional().describe("Only with legislation_type=act."),
    act_classification: z
      .enum(CLASSIFICATIONS)
      .optional()
      .describe("Only with legislation_type=act."),
    bill_type: z.enum(BILL_TYPES).optional().describe("Only with legislation_type=bill."),
    bill_status: z.enum(BILL_STATUSES).optional().describe("Only with legislation_type=bill."),
    instrument_type_group: z
      .enum(INSTRUMENT_TYPE_GROUPS)
      .optional()
      .describe("Only with legislation_type=secondary_legislation."),
    instrument_status: z
      .enum(INSTRUMENT_STATUSES)
      .optional()
      .describe("Only with legislation_type=secondary_legislation."),
    instrument_classification: z
      .enum(CLASSIFICATIONS)
      .optional()
      .describe("Only with legislation_type=secondary_legislation."),
    administering_agency: z
      .string()
      .trim()
      .min(1)
      .max(MAX_AGENCY_LENGTH)
      .optional()
      .describe(
        'Exact agency name as listed on legislation.govt.nz, e.g. "Inland Revenue Department".',
      ),
    publisher: z.enum(PUBLISHERS).optional(),
    sort_by: z.enum(SORT_ORDERS).optional(),
    page: z.number().int().min(1).max(MAX_PAGE).optional(),
    per_page: z.number().int().min(1).max(MAX_PER_PAGE).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    // Reject type-specific filters used without (or with the wrong) legislation_type.
    for (const type of LEGISLATION_TYPES) {
      for (const filter of TYPE_SPECIFIC_FILTERS[type]) {
        if (params[filter] !== undefined && params.legislation_type !== type) {
          ctx.addIssue({
            code: "custom",
            path: [filter],
            message: `${filter} only applies when legislation_type is "${type}". Set legislation_type to "${type}" or remove ${filter}.`,
          });
        }
      }
    }
  });

export type SearchParams = z.infer<typeof SearchParamsSchema>;

/**
 * Converts validated search params into API query parameters.
 * Our input names match the API's except `administering_agency` (API: `administering_agencies`).
 */
export function toSearchQuery(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as [string, string | number | undefined][]) {
    if (value === undefined) continue;
    query.set(key === "administering_agency" ? "administering_agencies" : key, String(value));
  }
  return query;
}

export const VersionListParamsSchema = z
  .object({
    work_id: WorkIdSchema,
    sort: z.enum(VERSION_SORTS).optional().describe("desc (newest first, default) or asc."),
    page: z.number().int().min(1).max(MAX_PAGE).optional(),
    per_page: z.number().int().min(1).max(MAX_PER_PAGE).optional(),
  })
  .strict();

export type VersionListParams = z.infer<typeof VersionListParamsSchema>;

// ---------------------------------------------------------------------------
// API response schemas (tolerant reader)
// ---------------------------------------------------------------------------

const optionalText = z.string().nullish();

/** Format links must be absolute https URLs; anything else is dropped by the caller. */
export const FormatSchema = z.object({
  type: z.string(),
  url: z.url({ protocol: /^https$/ }),
});

const classificationFields = {
  legislation_type: optionalText,
  legislation_status: optionalText,
  act_type: optionalText,
  act_status: optionalText,
  act_classification: optionalText,
  bill_type: optionalText,
  bill_status: optionalText,
  instrument_type_group: optionalText,
  instrument_status: optionalText,
  instrument_classification: optionalText,
  publisher: optionalText,
  administering_agencies: z.array(z.string()).nullish(),
};

const apiId = z.string().min(1).max(MAX_ID_LENGTH);

export const VersionRecordSchema = z.object({
  work_id: apiId,
  version_id: apiId,
  title: z.string(),
  formats: z.array(FormatSchema).nullish(),
  ...classificationFields,
});
export type VersionRecord = z.infer<typeof VersionRecordSchema>;

export const WorkSearchResultSchema = z.object({
  work_id: apiId,
  ...classificationFields,
  latest_matching_version: z.object({
    version_id: apiId,
    title: z.string(),
    is_latest_version: z.boolean().nullish(),
    formats: z.array(FormatSchema).nullish(),
  }),
});
export type WorkSearchResult = z.infer<typeof WorkSearchResultSchema>;

const pageFields = {
  page: z.number().int().min(1),
  per_page: z.number().int().min(1),
  total: z.number().int().min(0),
};

export const SearchResponseSchema = z.object({
  results: z.array(WorkSearchResultSchema),
  ...pageFields,
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const VersionListResponseSchema = z.object({
  results: z.array(VersionRecordSchema),
  ...pageFields,
});
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;

/** Error body shapes observed: `{"error":"API key is required"}` and `{"error":"404","message":"Not Found"}`. */
export const ApiErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});
