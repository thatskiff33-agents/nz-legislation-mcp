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
  cleanText,
  suffixOf,
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
    .describe("True if versions dated after as_at exist (later amendments, or later bill stages)."),
  provisional_id: z.boolean(),
  permalink: PermalinkSchema,
  ...ClassificationShape,
  links: LinksSchema,
  notes: z.array(z.string()),
});

type Output = z.output<typeof OutputSchema>;

/** Types whose versions are parliamentary stages rather than law in force. */
const STAGE_TYPES = new Set(["bill", "amendment_paper"]);
/** Current statuses that mean the work may not have been in force on a later as_at. */
const ENDED_STATUSES = new Set(["repealed", "revoked", "expired", "superseded", "terminated"]);

/** Orders same-date suffixes: "" < "A" < "B" < ... < "Z" < "AA". */
function suffixRank(suffix: string): [number, string] {
  return [suffix.length, suffix];
}

function laterSuffix(a: string, b: string): boolean {
  const [la, sa] = suffixRank(a);
  const [lb, sb] = suffixRank(b);
  return la !== lb ? la > lb : sa > sb;
}

function describe(
  record: VersionRecord,
  extra: { as_at: string | null; is_latest: boolean | null; newer: boolean | null },
  notes: string[],
): Output {
  const classification = classificationFrom(record);
  if (classification.agency_pilot_record) notes.push(AGENCY_PILOT_NOTE);
  if (extra.as_at !== null) {
    const stages = STAGE_TYPES.has(String(classification.legislation_type));
    if (stages) {
      notes.push(
        "For bills and amendment papers, versions are parliamentary stages, not law in force: this is the latest stage dated on or before as_at.",
      );
    }
    if (extra.newer === true) {
      notes.push(
        stages
          ? "Later stages exist, dated after as_at. Use list_versions to see them."
          : "Newer versions exist, dated after as_at (amendments made or in force later). Some later amendments may apply retrospectively to this date (common in tax legislation); check them with list_versions.",
      );
    }
    if (classification.type_status !== null && ENDED_STATUSES.has(classification.type_status)) {
      notes.push(
        stages
          ? `This bill's current status is "${classification.type_status}". Status fields describe today, not as_at.`
          : `This work's current status is "${classification.type_status}". Status fields describe today, not as_at; check whether it was still in force on ${extra.as_at}.`,
      );
    }
  }
  return {
    work_id: record.work_id,
    version_id: record.version_id,
    title: cleanText(record.title),
    version_date: versionDate(record.version_id),
    as_at: extra.as_at,
    is_latest_version: extra.is_latest,
    newer_versions_exist: extra.newer,
    provisional_id: isProvisional(record.version_id),
    permalink: permalink(record.version_id),
    ...classification,
    links: linksFrom(record.formats, record.version_id),
    notes,
  };
}

export const getLegislation = defineTool({
  name: "get_legislation",
  title: "Get a version of NZ legislation",
  description: [
    "Get metadata and links for one version of a piece of NZ legislation.",
    "Pass work_id (from search_legislation) for the version as at a date (as_at, default today in New Zealand), or pass a specific version_id.",
    "A version dated D shows the law as at D; amendments made later with retrospective effect are not included, so check newer versions for past tax years.",
    "For bills, versions are parliamentary stages, not law in force.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, { client, today, logger }, signal) {
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

    // Scan newest-first. Once a version dated on or before as_at is found, collect every
    // version with that same date (possibly spilling onto the next page) and choose the last
    // of the day: the highest suffix letter (API data: 2008-04-01B is listed before 2008-04-01).
    // "Latest" uses the same rule on the newest date, so API ordering cannot change either.
    let newestDate: string | undefined;
    let latestId: string | undefined;
    let earliest: string | undefined;
    let scanned = 0;
    let chosenDate: string | undefined;
    const sameDay: VersionRecord[] = [];
    let exhausted = false;
    let leftDate = false;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const response = await client.listVersions(
        { work_id: workId, sort: "desc", page, per_page: PER_PAGE },
        { signal },
      );
      for (const version of response.results) {
        scanned += 1;
        const date = versionDate(version.version_id);
        if (date === null) {
          logger.warn("skipping version with unparseable date", { version_id: version.version_id });
          continue;
        }
        earliest = version.version_id;
        newestDate ??= date;
        if (
          date === newestDate &&
          (latestId === undefined || laterSuffix(suffixOf(version.version_id), suffixOf(latestId)))
        ) {
          latestId = version.version_id;
        }
        if (chosenDate === undefined && date <= asAt) chosenDate = date;
        if (chosenDate !== undefined) {
          if (date === chosenDate) sameDay.push(version);
          else {
            leftDate = true;
            break;
          }
        }
      }
      const lastPage = response.results.length === 0 || page * response.per_page >= response.total;
      if (lastPage) exhausted = true;
      if (leftDate || lastPage) break;
    }

    const first = sameDay[0];
    if (first !== undefined) {
      let chosen = first;
      for (const candidate of sameDay) {
        if (laterSuffix(suffixOf(candidate.version_id), suffixOf(chosen.version_id)))
          chosen = candidate;
      }
      if (sameDay.length > 1) {
        notes.push(
          `Several versions share the date ${String(chosenDate)} (${sameDay.map((v) => v.version_id).join(", ")}); the last of the day (${chosen.version_id}) was used.`,
        );
      }
      if (!exhausted && !leftDate) {
        notes.push(
          `The version history was only scanned to ${String(scanned)} versions, so more versions dated ${String(chosenDate)} may exist. Check with list_versions.`,
        );
      }
      const newer = chosen.version_id !== latestId;
      return describe(chosen, { as_at: asAt, is_latest: !newer, newer }, notes);
    }

    if (latestId === undefined) {
      throw new ToolInputError(`No versions were found for ${workId}.`);
    }
    if (!exhausted) {
      throw new ToolInputError(
        `Searched the newest ${String(scanned)} versions of ${workId} without reaching ${asAt}. Use list_versions with sort=asc to find older versions, then get_legislation with that version_id.`,
      );
    }
    throw new ToolInputError(
      `No version of ${workId} is dated on or before ${asAt}. The earliest version is ${String(earliest)}; use a later as_at.`,
    );
  },
});
