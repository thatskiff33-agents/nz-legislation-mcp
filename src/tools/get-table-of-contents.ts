/** get_table_of_contents: the structure of one version (parts, subparts, sections, schedules). */
import { z } from "zod";
import { readLegislation, normaliseLabel, type OutlineEntry } from "../text/document.js";
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
  })
  .superRefine(refineSelector);

const EntrySchema = z.object({
  kind: z.enum(["part", "subpart", "crosshead", "section", "schedule"]),
  label: z.string(),
  heading: z.string(),
  depth: z.number().int(),
  schedule: z.string().nullable(),
});

const OutputSchema = z.object({
  ...VersionInfoShape,
  title: z.string(),
  permalink: PermalinkSchema,
  scope: z.string().describe("What the entries cover."),
  total_entries: z.number().int().describe("Entries in the whole document."),
  truncated: z.boolean(),
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
  };
}

export const getTableOfContents = defineTool({
  name: "get_table_of_contents",
  title: "Table of contents",
  description: [
    "List the structure of a version of NZ legislation: parts, subparts, cross-headings, sections and schedules, with labels to pass to get_provision_text.",
    "Choose the version with work_id (+ as_at) or version_id. For large Acts, pass part to list the sections inside one part or subpart.",
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
    if (args.part !== undefined) {
      const wanted = normaliseLabel(args.part);
      chosen = doc.outline.filter(
        (e) =>
          e.within.some((label) => normaliseLabel(label) === wanted) ||
          ((e.kind === "part" || e.kind === "subpart") && normaliseLabel(e.label) === wanted),
      );
      scope = `Everything in part/subpart ${args.part}.`;
      if (chosen.length === 0) {
        notes.push(
          `No part or subpart labelled "${args.part}" was found. Omit part to see the top level.`,
        );
      }
    } else if (doc.outline.length <= FULL_OUTLINE_LIMIT) {
      chosen = [...doc.outline];
      scope = "The whole document.";
    } else {
      chosen = doc.outline.filter(
        (e) =>
          e.kind === "part" ||
          e.kind === "subpart" ||
          e.kind === "schedule" ||
          (e.kind === "section" && e.within.length === 0 && e.schedule === null),
      );
      scope = "Parts, subparts, schedules and sections outside any part.";
      notes.push(
        `This document has ${String(doc.outline.length)} entries. Pass part (e.g. a part or subpart label above) to list its sections.`,
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
