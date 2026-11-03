/**
 * Choosing a version: directly by version_id, or the version of a work as at a date.
 * Shared by get_legislation and the text tools so every tool reads "as at" the same way.
 */
import { z } from "zod";
import type { LegislationClient, VersionRecord } from "../api/client.js";
import { VersionIdSchema, WorkIdSchema } from "../domain/schemas.js";
import type { Logger } from "../logger.js";
import { suffixOf, ToolInputError, versionDate } from "./shared.js";

/** Bound on version-history pages scanned for as_at (100 versions per page). */
const MAX_HISTORY_PAGES = 20;
const PER_PAGE = 100;

/** Input fields that pick a version. Combine with {@link refineSelector}. */
export const VersionSelectorShape = {
  work_id: WorkIdSchema.optional(),
  version_id: VersionIdSchema.optional(),
  as_at: z.iso
    .date()
    .optional()
    .describe(
      "Date (YYYY-MM-DD): use the version as at this date. Only with work_id. Defaults to today in New Zealand.",
    ),
};

interface SelectorArgs {
  readonly work_id?: string | undefined;
  readonly version_id?: string | undefined;
  readonly as_at?: string | undefined;
}

/** Cross-field rules for {@link VersionSelectorShape}. */
export function refineSelector(args: SelectorArgs, ctx: z.RefinementCtx): void {
  if ((args.work_id === undefined) === (args.version_id === undefined)) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of work_id or version_id." });
  }
  if (args.as_at !== undefined && args.version_id !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["as_at"],
      message: "as_at only applies with work_id (a version_id already fixes the date).",
    });
  }
}

export interface Selected {
  readonly record: VersionRecord;
  /** The as-at date used, or null when chosen by version_id. */
  readonly asAt: string | null;
  /** Whether this is the newest version, or null when unknown (chosen by version_id). */
  readonly isLatest: boolean | null;
  readonly notes: string[];
}

/** Orders same-date suffixes: "" < "A" < "B" < ... < "Z" < "AA". */
function laterSuffix(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b;
}

/** Picks a version per the selector. Notes explain any defaults or ambiguity. */
export async function selectVersion(
  args: SelectorArgs,
  deps: { client: LegislationClient; logger: Logger; today: () => string },
  signal: AbortSignal,
): Promise<Selected> {
  const { client, logger } = deps;
  const notes: string[] = [];
  if (args.version_id !== undefined) {
    const record = await client.getVersion(args.version_id, { signal });
    return { record, asAt: null, isLatest: null, notes };
  }
  const workId = args.work_id;
  if (workId === undefined) {
    // Unreachable through MCP (the input schema requires one identifier); kept for direct callers.
    throw new ToolInputError("Provide exactly one of work_id or version_id.");
  }
  const asAt = args.as_at ?? deps.today();
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
    return { record: chosen, asAt, isLatest: chosen.version_id === latestId, notes };
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
}
