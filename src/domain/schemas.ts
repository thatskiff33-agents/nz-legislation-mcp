/**
 * Zod schemas for everything that crosses a trust boundary.
 *
 * Inputs (tool arguments) are strict: exact enums, bounded lengths, no control characters and
 * cross-field rules, because the API silently ignores invalid filters and would otherwise
 * return misleading "no results" answers.
 *
 * API responses are parsed tolerantly ("tolerant reader"): unknown fields are stripped,
 * enum-like fields are plain strings and invalid format links are dropped individually, so a
 * new value or one bad link from PCO does not break every tool. Vocabulary drift is detected
 * separately by contract tests against the live API.
 */
import { z } from "zod";
import { parseVersionId, parseWorkId } from "./ids.js";
import {
  ACT_STATUSES,
  ACT_TYPES,
  AGENCY_PUBLISHED_TYPES,
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
  AGENCY_PUBLISHER,
  API_LIMITS,
  orList,
} from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Rejects control characters (C0, DEL and C1: NUL, newlines, etc.) in free text. Written with
 * explicit ranges, not \p{Cc}, so the emitted JSON Schema pattern works in every regex engine.
 * U+2028 and U+2029 (line and paragraph separators) are refused too: they act as line breaks.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const NO_CONTROL_CHARS = /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/;

/** Trimmed, non-empty, length-limited text with no control characters. */
export function freeText(max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(NO_CONTROL_CHARS, { error: "Must not contain control characters." });
}

/** Builds a strict object whose unknown-key error lists the allowed parameters. */
function strictParams<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, z.core.$strict> {
  const allowed = Object.keys(shape).join(", ");
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unknown parameter(s): ${issue.keys.join(", ")}. Allowed parameters: ${allowed}.`
        : undefined,
  });
}

// ---------------------------------------------------------------------------
// Identifier input schemas (the parser enforces length, grammar and vocabulary)
// ---------------------------------------------------------------------------

export const WorkIdSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = parseWorkId(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
  })
  .describe(
    "Work identifier from search_legislation, e.g. act_public_2007_97 (Income Tax Act 2007).",
  );

export const VersionIdSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = parseVersionId(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
  })
  .describe(
    "Version identifier from get_legislation or list_versions, e.g. act_public_2007_97_en_2025-05-29.",
  );

// ---------------------------------------------------------------------------
// Search input schema
// ---------------------------------------------------------------------------

/** Maximum search term length. The API uses Elasticsearch simple query string syntax. */
const MAX_SEARCH_TERM_LENGTH = 500;
/** Agency names must match the website's "browse agencies" list exactly. */
const MAX_AGENCY_LENGTH = 200;
/** API maximum page size (used for version lists, whose items are small). */
export const MAX_PER_PAGE = API_LIMITS.maxPerPage;
/** Search page cap: search results are large, so 50 keeps a page within client output limits. */
export const MAX_SEARCH_PER_PAGE = 50;
/** Sanity bound on page numbers (the whole corpus is under 50,000 works, so under 500 pages of 100). */
const MAX_PAGE = 10_000;

const pageParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE)
  .optional()
  .describe("Page number, starting at 1.");
const perPageParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_PER_PAGE)
  .optional()
  .describe(
    `Results per page, 1 to ${String(MAX_PER_PAGE)}. API default is ${String(API_LIMITS.defaultPerPage)}.`,
  );

const onlyWith = (type: string): string => `Only with legislation_type=${type}.`;

/**
 * Flat object (no root-level union) because several MCP clients mishandle `oneOf`/`anyOf`
 * at the root of a tool input schema. Cross-field rules are enforced in `superRefine`.
 */
export const SearchParamsSchema = strictParams({
  search_term: freeText(MAX_SEARCH_TERM_LENGTH)
    .optional()
    .describe(
      "Words to search for. Stemming is on (levy matches levies); wrap a word or phrase in double quotes for an exact match. Omit to browse by filters alone.",
    ),
  search_field: z
    .enum(SEARCH_FIELDS)
    .optional()
    .describe("Search titles only (title) or the full text (content)."),
  legislation_type: z.enum(LEGISLATION_TYPES).optional().describe("Kind of legislation."),
  legislation_status: z
    .enum(LEGISLATION_STATUSES)
    .optional()
    .describe(`${orList(LEGISLATION_STATUSES)} (no_value: status not recorded, e.g. bills).`),
  act_type: z.enum(ACT_TYPES).optional().describe(onlyWith("act")),
  act_status: z.enum(ACT_STATUSES).optional().describe(onlyWith("act")),
  act_classification: z.enum(CLASSIFICATIONS).optional().describe(onlyWith("act")),
  bill_type: z.enum(BILL_TYPES).optional().describe(onlyWith("bill")),
  bill_status: z.enum(BILL_STATUSES).optional().describe(onlyWith("bill")),
  instrument_type_group: z
    .enum(INSTRUMENT_TYPE_GROUPS)
    .optional()
    .describe(onlyWith("secondary_legislation")),
  instrument_status: z
    .enum(INSTRUMENT_STATUSES)
    .optional()
    .describe(onlyWith("secondary_legislation")),
  instrument_classification: z
    .enum(CLASSIFICATIONS)
    .optional()
    .describe(onlyWith("secondary_legislation")),
  administering_agency: freeText(MAX_AGENCY_LENGTH)
    .optional()
    .describe(
      'Exact agency name as listed on legislation.govt.nz, e.g. "Inland Revenue Department".',
    ),
  publisher: z
    .enum(PUBLISHERS)
    .optional()
    .describe(
      '"Parliamentary Counsel Office" (all Acts, Bills, amendment papers and PCO-drafted secondary legislation) or "Agency" (agency-published secondary legislation from a pilot service; records may be inaccurate or incomplete).',
    ),
  sort_by: z
    .enum(SORT_ORDERS)
    .optional()
    .describe("Sort order. most_recently_updated sorts by latest version date, newest first."),
  page: pageParam,
  per_page: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_PER_PAGE)
    .optional()
    .describe(
      `Results per page, 1 to ${String(MAX_SEARCH_PER_PAGE)}. Default ${String(API_LIMITS.defaultPerPage)}.`,
    ),
}).superRefine((params, ctx) => {
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
  // Agency-published works are only ever secondary legislation (confirmed live: act + Agency
  // returns zero results rather than an error).
  const type = params.legislation_type;
  if (
    params.publisher === AGENCY_PUBLISHER &&
    type !== undefined &&
    !(AGENCY_PUBLISHED_TYPES as readonly string[]).includes(type)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["publisher"],
      message: `publisher "Agency" only applies to ${AGENCY_PUBLISHED_TYPES.join(", ")}. Remove publisher or change legislation_type.`,
    });
  }
});

export type SearchParams = z.infer<typeof SearchParamsSchema>;

/**
 * Converts validated search params into API query parameters.
 * Our input names match the API's except `administering_agency` (API: `administering_agencies`).
 */
export function toSearchQuery(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries<string | number | undefined>(params)) {
    if (value === undefined) continue;
    query.set(key === "administering_agency" ? "administering_agencies" : key, String(value));
  }
  return query;
}

export const VersionListParamsSchema = strictParams({
  work_id: WorkIdSchema,
  sort: z.enum(VERSION_SORTS).optional().describe("desc (newest first, default) or asc."),
  page: pageParam,
  per_page: perPageParam,
});

export type VersionListParams = z.infer<typeof VersionListParamsSchema>;

// ---------------------------------------------------------------------------
// API response schemas (tolerant reader)
// ---------------------------------------------------------------------------

const optionalText = z.string().nullish();

/**
 * A usable format link: absolute https URL without embedded credentials. Any host is allowed
 * here because agency-published records link to agency websites; code that *fetches* a link
 * must separately allowlist the host and must never attach the API key.
 *
 * @internal Exported for tests.
 */
export const FormatSchema = z
  .object({ type: z.string(), url: z.url({ protocol: /^https$/ }) })
  .refine(({ url }) => {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "";
  }, "Format URL must not contain credentials.");

/** A list of format links where invalid entries are dropped instead of failing the response. */
const FormatListSchema = z
  .array(z.unknown())
  .nullish()
  .transform((items) =>
    (items ?? []).flatMap((item) => {
      const parsed = FormatSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );

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

/** Identifiers from the API: generous bound, validated again before any use in a URL. */
const apiId = z.string().min(1).max(500);

export const VersionRecordSchema = z.object({
  work_id: apiId,
  version_id: apiId,
  title: z.string(),
  formats: FormatListSchema,
  ...classificationFields,
});

const WorkSearchResultSchema = z.object({
  work_id: apiId,
  ...classificationFields,
  latest_matching_version: z.object({
    version_id: apiId,
    title: z.string(),
    is_latest_version: z.boolean().nullish(),
    formats: FormatListSchema,
  }),
});

const pageFields = {
  page: z.number().int().min(1),
  per_page: z.number().int().min(1),
  total: z.number().int().min(0),
};

export const SearchResponseSchema = z.object({
  results: z.array(WorkSearchResultSchema),
  ...pageFields,
});

export const VersionListResponseSchema = z.object({
  results: z.array(VersionRecordSchema),
  ...pageFields,
  // Not required by the spec for this endpoint: callers fall back to the size they asked for.
  per_page: pageFields.per_page.optional(),
});
