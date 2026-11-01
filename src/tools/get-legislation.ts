/**
 * get_legislation: metadata and links for one version, chosen directly by version_id or as the
 * version of a work in force on a given date (default: today in New Zealand).
 */
import { z } from "zod";
import type { VersionRecord } from "../api/client.js";
import { VersionIdSchema, WorkIdSchema } from "../domain/schemas.js";
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
  ToolInputError,
  versionDate,
} from "./shared.js";

/** Bound on version-history pages scanned for as_at (100 versions per page). */
const MAX_HISTORY_PAGES = 20;
const PER_PAGE = 100;

const InputSchema = z
  .strictObject({
    work_id: WorkIdSchema.optional(),
    version_id: VersionIdSchema.optional(),
    as_at: z.iso
      .date()
      .optional()
      .describe(
        "Date (YYYY-MM-DD) to find the version in force on. Only with work_id. Defaults to today in New Zealand.",
      ),
  })
  .superRefine((args, ctx) => {
    if ((args.work_id === undefined) === (args.version_id === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of work_id or version_id.",
      });
    }
    if (args.as_at !== undefined && args.version_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["as_at"],
        message: "as_at only applies with work_id (a version_id already fixes the date).",
      });
    }
  });

const OutputSchema = z.object({
  work_id: z.string(),
  version_id: z.string(),
  title: z.string(),
  version_date: z.string().nullable().describe("As-at date of this version (YYYY-MM-DD)."),
  as_at: z.string().nullable().describe("The date the version was chosen for, if by work_id."),
  is_latest_version: z.boolean().nullable(),
  newer_versions_exist: z
    .boolean()
    .nullable()
    .describe("True if versions dated after as_at exist (e.g. amendments not yet in force)."),
  provisional_id: z.boolean(),
  permalink: PermalinkSchema,
  ...ClassificationShape,
  links: LinksSchema,
  notes: z.array(z.string()),
});

type Output = z.output<typeof OutputSchema>;

function describe(
  record: VersionRecord,
  extra: { as_at: string | null; is_latest: boolean | null; newer: boolean | null },
  notes: string[],
): Output {
  const classification = classificationFrom(record);
  if (classification.agency_pilot_record) notes.push(AGENCY_PILOT_NOTE);
  return {
    work_id: record.work_id,
    version_id: record.version_id,
    title: record.title,
    version_date: versionDate(record.version_id),
    as_at: extra.as_at,
    is_latest_version: extra.is_latest,
    newer_versions_exist: extra.newer,
    provisional_id: isProvisional(record.version_id),
    permalink: permalink(record.version_id),
    ...classification,
    links: linksFrom(record.formats),
    notes,
  };
}

export const getLegislation = defineTool({
  name: "get_legislation",
  title: "Get a version of NZ legislation",
  description: [
    "Get metadata and official links for one version of a piece of NZ legislation.",
    "Pass work_id (from search_legislation) to get the version in force on as_at (default: today in New Zealand), or pass a specific version_id.",
    "Use as_at for questions about the law at a past date, e.g. a tax year.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, { client, today }, signal) {
    const notes = [OFFICIAL_SOURCE_NOTE];

    if (args.version_id !== undefined) {
      const record = await client.getVersion(args.version_id, { signal });
      return describe(record, { as_at: null, is_latest: null, newer: null }, notes);
    }

    const workId = args.work_id;
    if (workId === undefined) {
      // Unreachable through MCP (the input schema requires one identifier); kept for direct callers.
      throw new ToolInputError("Provide exactly one of work_id or version_id.");
    }
    const asAt = args.as_at ?? today();
    if (args.as_at === undefined) notes.push(`as_at defaulted to today in New Zealand (${asAt}).`);

    let latestId: string | undefined;
    let earliest: string | undefined;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const response = await client.listVersions(
        { work_id: workId, sort: "desc", page, per_page: PER_PAGE },
        { signal },
      );
      latestId ??= response.results[0]?.version_id;
      for (const version of response.results) {
        const date = versionDate(version.version_id);
        earliest = version.version_id;
        if (date !== null && date <= asAt) {
          const newer = version.version_id !== latestId;
          if (newer) {
            notes.push(
              "Newer versions exist, dated after as_at (for example amendments not yet in force). Use list_versions to see them.",
            );
          }
          return describe(version, { as_at: asAt, is_latest: !newer, newer }, notes);
        }
      }
      if (page * PER_PAGE >= response.total) break;
    }

    if (latestId === undefined) {
      throw new ToolInputError(`No versions were found for ${workId}.`);
    }
    throw new ToolInputError(
      `No version of ${workId} is dated on or before ${asAt}. The earliest version found is ${String(earliest)}; use a later as_at.`,
    );
  },
});
