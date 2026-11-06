/**
 * get_legislation: metadata and links for one version, chosen directly by version_id or as the
 * version of a work in force on a given date (default: today in New Zealand).
 */
import { z } from "zod";
import type { VersionRecord } from "../api/client.js";
import { ENDED_STATUSES, STAGE_TYPES } from "../domain/vocabulary.js";
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
  versionDate,
} from "./shared.js";
import { refineSelector, selectVersion, VersionSelectorShape } from "./versions.js";

const InputSchema = z.strictObject(VersionSelectorShape).superRefine(refineSelector);

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
const STAGES = new Set<string>(STAGE_TYPES);
/** Current statuses that mean the work may not have been in force on a later as_at. */
const ENDED = new Set<string>(ENDED_STATUSES);

function describe(
  record: VersionRecord,
  extra: { as_at: string | null; is_latest: boolean | null; newer: boolean | null },
  notes: string[],
): Output {
  const classification = classificationFrom(record);
  if (classification.agency_pilot_record) notes.push(AGENCY_PILOT_NOTE);
  if (extra.as_at !== null) {
    const stages = STAGES.has(String(classification.legislation_type));
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
    if (classification.type_status !== null && ENDED.has(classification.type_status)) {
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
  async run(args, deps, signal) {
    const selected = await selectVersion(args, deps, signal);
    const newer = selected.isLatest === null ? null : !selected.isLatest;
    return describe(
      selected.record,
      { as_at: selected.asAt, is_latest: selected.isLatest, newer },
      [OFFICIAL_SOURCE_NOTE, ...selected.notes],
    );
  },
});
