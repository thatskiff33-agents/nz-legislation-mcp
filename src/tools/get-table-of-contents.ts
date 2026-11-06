/** get_table_of_contents: the structure of one version (parts, subparts, sections, schedules). */
import { z } from "zod";
import {
  normaliseLabel,
  normalisePartLabel,
  readLegislation,
  type OutlineEntry,
} from "../text/document.js";
import { cleanText, defineTool, permalink, PermalinkSchema, READ_ONLY_API_TOOL } from "./shared.js";
import { LabelSchema, versionInfo, VersionInfoShape } from "./text-common.js";
import { refineSelector, selectVersion, VersionSelectorShape } from "./versions.js";

/** Below this many entries the whole outline is returned. */
const FULL_OUTLINE_LIMIT = 300;
/** Hard cap on returned entries. */
const MAX_ENTRIES = 500;

const InputSchema = z
  .strictObject({
    ...VersionSelectorShape,
    part: LabelSchema.min(1)
      .optional()
      .describe(
        'Only list what is inside this part or subpart (label, e.g. "C" or "CB"). Large Acts list parts and subparts only unless you give one.',
      ),
    schedule: LabelSchema.optional().describe(
      'Only list what is inside this schedule (label, e.g. "1"; "" for an unnumbered schedule), including its clauses. Use it to find clause labels in large Acts.',
    ),
  })
  .superRefine((args, ctx) => {
    refineSelector(args, ctx);
    if (args.part !== undefined && args.schedule !== undefined) {
      ctx.addIssue({ code: "custom", message: "Give part or schedule, not both." });
    }
  });

const EntrySchema = z.object({
  kind: z.enum(["part", "subpart", "crosshead", "section", "schedule"]),
  label: z.string(),
  heading: z.string(),
  depth: z.number().int(),
  schedule: z.string().nullable(),
  repealed: z.boolean(),
});

const OutputSchema = z.object({
  ...VersionInfoShape,
  title: z.string(),
  permalink: PermalinkSchema,
  scope: z.string().describe("What the entries cover."),
  total_entries: z.number().int().describe("Entries in the whole document."),
  truncated: z
    .boolean()
    .describe(
      "True if more entries matched than are listed (at most 500); see notes for how to narrow.",
    ),
  entries: z.array(EntrySchema),
  notes: z.array(z.string()),
});

function toEntry(e: OutlineEntry): z.output<typeof EntrySchema> {
  return {
    kind: e.kind,
    label: cleanText(e.label),
    heading: cleanText(e.heading),
    depth: e.depth,
    schedule: e.schedule === null ? null : cleanText(e.schedule),
    repealed: e.repealed,
  };
}

export const getTableOfContents = defineTool({
  name: "get_table_of_contents",
  title: "Table of contents",
  description: [
    "List the structure of a version of NZ legislation: parts, subparts, cross-headings, sections and schedules, with labels to pass to get_provision_text.",
    "Choose the version with work_id (+ as_at) or version_id. For large Acts, pass part to list the sections inside one part or subpart, or schedule to list one schedule's clauses.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, deps, signal) {
    const selected = await selectVersion(args, deps, signal);
    const { record } = selected;
    const doc = await readLegislation(deps.xml(record.version_id, signal), { fullOutline: true });
    const notes = [...selected.notes];

    let chosen: OutlineEntry[];
    let scope: string;
    if (args.schedule !== undefined) {
      const wanted = normaliseLabel(args.schedule);
      chosen = doc.outline.filter((e) =>
        e.kind === "schedule"
          ? normaliseLabel(e.label) === wanted
          : e.schedule !== null && normaliseLabel(e.schedule) === wanted,
      );
      scope = `Everything in schedule ${args.schedule === "" ? "(unnumbered)" : args.schedule}.`;
      if (chosen.length === 0) {
        notes.push(
          `No schedule labelled "${args.schedule}" was found. Omit schedule to see the schedules.`,
        );
      }
    } else if (args.part !== undefined) {
      const wanted = normalisePartLabel(args.part);
      // Body parts only: schedules have their own parts, often reusing labels such as "A".
      chosen = doc.outline.filter(
        (e) =>
          e.schedule === null &&
          (e.within.some((label) => normalisePartLabel(label) === wanted) ||
            ((e.kind === "part" || e.kind === "subpart") &&
              normalisePartLabel(e.label) === wanted)),
      );
      scope = `Everything in part/subpart ${args.part}.`;
      if (chosen.length === 0) {
        notes.push(
          `No part or subpart labelled "${args.part}" was found. Omit part to see the top level.`,
        );
      } else if (chosen.length > MAX_ENTRIES) {
        const subparts = chosen.filter((e) => e.kind === "part" || e.kind === "subpart");
        if (subparts.length > 1) {
          const count = chosen.length;
          chosen = subparts;
          scope = `Subparts of ${args.part} (it has too many entries to list at once).`;
          notes.push(
            `"${args.part}" has ${String(count)} entries, too many to list at once; pass one of the subpart labels above to list its sections.`,
          );
        }
      }
    } else if (doc.outline.length <= FULL_OUTLINE_LIMIT) {
      chosen = [...doc.outline];
      scope = "The whole document.";
    } else {
      chosen = doc.outline.filter(
        (e) =>
          e.kind === "schedule" ||
          (e.schedule === null &&
            (e.kind === "part" ||
              e.kind === "subpart" ||
              (e.kind === "section" && e.within.length === 0))),
      );
      scope = "Body parts and subparts, schedules, and sections outside any part.";
      notes.push(
        `This document has ${String(doc.outline.length)} entries. Pass part (a part or subpart label above) to list its sections, or schedule (a schedule label above) to list its clauses.`,
      );
    }

    if (chosen.length > MAX_ENTRIES) {
      notes.push(
        args.schedule === undefined
          ? `Only the first ${String(MAX_ENTRIES)} of ${String(chosen.length)} matching entries are listed. Pass a narrower part or subpart, or a schedule, to see the rest.`
          : `Only the first ${String(MAX_ENTRIES)} of ${String(chosen.length)} entries in this schedule are listed. Use get_provision_text with the schedule and a clause label to read clauses further down.`,
      );
    }

    return {
      ...versionInfo(record),
      title: cleanText(doc.title === "" ? record.title : doc.title),
      permalink: permalink(record.version_id),
      scope,
      total_entries: doc.outline.length,
      truncated: chosen.length > MAX_ENTRIES,
      entries: chosen.slice(0, MAX_ENTRIES).map(toEntry),
      notes,
    };
  },
});
