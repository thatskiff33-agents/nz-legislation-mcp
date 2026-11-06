/** list_versions: the point-in-time version history of one work. */
import { z } from "zod";
import { MAX_PER_PAGE, VersionListParamsSchema } from "../domain/schemas.js";
import { API_LIMITS } from "../domain/vocabulary.js";
import {
  cleanText,
  defineTool,
  linksFrom,
  LinksSchema,
  permalink,
  PermalinkSchema,
  READ_ONLY_API_TOOL,
  versionDate,
} from "./shared.js";

const OutputSchema = z.object({
  work_id: z.string(),
  total: z.number().int(),
  page: z.number().int(),
  per_page: z.number().int(),
  has_more: z.boolean(),
  versions: z.array(
    z.object({
      version_id: z.string(),
      title: z.string(),
      version_date: z.string().nullable().describe("As-at date (YYYY-MM-DD)."),
      permalink: PermalinkSchema,
      links: LinksSchema,
    }),
  ),
});

export const listVersions = defineTool({
  name: "list_versions",
  title: "List versions of a work",
  description: [
    "List the versions of one work (e.g. an Act as at each amendment date), newest first by default.",
    `Each version_id can be passed to get_legislation. Use per_page up to ${String(MAX_PER_PAGE)} and page to go further back.`,
    "To find the version in force on a particular date, prefer get_legislation with as_at.",
  ].join(" "),
  inputSchema: VersionListParamsSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, { client }, signal) {
    const response = await client.listVersions(args, { signal });
    // per_page is not required in the API response: fall back to the size asked for.
    const perPage = response.per_page ?? args.per_page ?? API_LIMITS.defaultPerPage;
    return {
      work_id: args.work_id,
      total: response.total,
      page: response.page,
      per_page: perPage,
      has_more: response.page * perPage < response.total,
      versions: response.results.map((v) => ({
        version_id: v.version_id,
        title: cleanText(v.title),
        version_date: versionDate(v.version_id),
        permalink: permalink(v.version_id),
        links: linksFrom(v.formats, v.version_id),
      })),
    };
  },
});
