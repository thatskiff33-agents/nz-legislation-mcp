/** search_legislation: search or browse works, mirroring the legislation.govt.nz search. */
import { z } from "zod";
import { SearchParamsSchema } from "../domain/schemas.js";
import {
  AGENCY_PILOT_NOTE,
  ClassificationShape,
  classificationFrom,
  defineTool,
  isProvisional,
  linksFrom,
  LinksSchema,
  OFFICIAL_SOURCE_NOTE,
  permalink,
  PermalinkSchema,
  READ_ONLY_API_TOOL,
  versionDate,
} from "./shared.js";

const ResultSchema = z.object({
  work_id: z.string(),
  title: z.string(),
  latest_matching_version_id: z.string(),
  version_date: z.string().nullable().describe("As-at date of that version (YYYY-MM-DD)."),
  is_latest_version: z.boolean().nullable(),
  provisional_id: z.boolean().describe("True if the identifiers may change (agency records)."),
  permalink: PermalinkSchema,
  ...ClassificationShape,
  links: LinksSchema,
});

const OutputSchema = z.object({
  total: z.number().int(),
  page: z.number().int(),
  per_page: z.number().int(),
  has_more: z.boolean(),
  results: z.array(ResultSchema),
  notes: z.array(z.string()),
});

export const searchLegislation = defineTool({
  name: "search_legislation",
  title: "Search NZ legislation",
  description: [
    "Search New Zealand Acts, Bills, secondary legislation (regulations, orders, rules, etc.) and amendment papers on legislation.govt.nz.",
    "Search titles (search_field=title) or full text (search_field=content), or omit search_term to browse by filters.",
    "Type-specific filters (act_*, bill_*, instrument_*) require the matching legislation_type.",
    "Returns work_id values for get_legislation and list_versions. Results are paged (per_page up to 100).",
  ].join(" "),
  inputSchema: SearchParamsSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, { client }, signal) {
    const response = await client.searchWorks(args, { signal });
    const results = response.results.map((work) => {
      const version = work.latest_matching_version;
      return {
        work_id: work.work_id,
        title: version.title,
        latest_matching_version_id: version.version_id,
        version_date: versionDate(version.version_id),
        is_latest_version: version.is_latest_version ?? null,
        provisional_id: isProvisional(version.version_id),
        permalink: permalink(version.version_id),
        ...classificationFrom(work),
        links: linksFrom(version.formats),
      };
    });
    const notes = [OFFICIAL_SOURCE_NOTE];
    if (results.some((r) => r.agency_pilot_record)) notes.push(AGENCY_PILOT_NOTE);
    return {
      total: response.total,
      page: response.page,
      per_page: response.per_page,
      has_more: response.page * response.per_page < response.total,
      results,
      notes,
    };
  },
});
