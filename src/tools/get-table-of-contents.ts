/** get_table_of_contents: the structure of one version (parts, subparts, sections, schedules). */
import { z } from "zod";
import {
  isWithin,
  normaliseLabel,
  normalisePartLabel,
  readLegislation,
  type OutlineEntry,
} from "../text/document.js";
import { cleanText, defineTool, permalink, PermalinkSchema, READ_ONLY_API_TOOL } from "./shared.js";
import {
  bareLabel,
  describeEnclosing,
  describeScope,
  LabelSchema,
  PartSchema,
  scopeHint,
  SubpartSchema,
  versionInfo,
  VersionInfoShape,
} from "./text-common.js";
import { refineSelector, selectVersion, VersionSelectorShape } from "./versions.js";

/** Below this many entries the whole outline is returned. */
const FULL_OUTLINE_LIMIT = 300;
/** Hard cap on returned entries. */
const MAX_ENTRIES = 500;

const InputSchema = z
  .strictObject({
    ...VersionSelectorShape,
    part: PartSchema.optional().describe(
      'Only list what is inside this Part (label, e.g. "2" or "C"). Large Acts list parts and subparts only unless you give one.',
    ),
    subpart: SubpartSchema.optional().describe(
      'Only list what is inside this Subpart (label, e.g. "1" or "CB"). Subpart numbers often restart in each Part, so give part as well.',
    ),
    schedule: LabelSchema.optional().describe(
      'Only list what is inside this schedule (label, e.g. "1"; "" for an unnumbered schedule), including its clauses. Use it to find clause labels in large Acts.',
    ),
  })
  .superRefine((args, ctx) => {
    refineSelector(args, ctx);
    if ((args.part !== undefined || args.subpart !== undefined) && args.schedule !== undefined) {
      ctx.addIssue({ code: "custom", message: "Give part/subpart or schedule, not both." });
    }
  });

/** True for the part or subpart entry the caller named (it heads its own listing). */
function isScopeItself(e: OutlineEntry, part: string | undefined, subpart: string | undefined) {
  if (subpart === undefined) {
    return (
      e.kind === "part" &&
      part !== undefined &&
      normalisePartLabel(e.label) === normalisePartLabel(part)
    );
  }
  return (
    e.kind === "subpart" &&
    normalisePartLabel(e.label) === normalisePartLabel(subpart) &&
    isWithin(e.within, part, undefined)
  );
}

const EntrySchema = z.object({
  kind: z.enum(["part", "subpart", "crosshead", "section", "schedule"]),
  label: z.string(),
  heading: z.string(),
  depth: z.number().int(),
  schedule: z.string().nullable(),
  repealed: z.boolean(),
  within: z
    .array(z.string())
    .describe(
      'Enclosing parts and subparts, e.g. ["Part 2", "Subpart 1"], to pass as part and subpart.',
    ),
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
    within: e.within.map(describeEnclosing),
  };
}

export const getTableOfContents = defineTool({
  name: "get_table_of_contents",
  title: "Table of contents",
  description: [
    "List the structure of a version of NZ legislation: parts, subparts, cross-headings, sections and schedules, with labels to pass to get_provision_text.",
    "Choose the version with work_id (+ as_at) or version_id. For large Acts, pass part to list one Part's sections (with subpart for one subpart: subpart numbers often restart in each Part), or schedule to list one schedule's clauses. Each entry's within names its enclosing parts and subparts.",
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
    } else if (args.part !== undefined || args.subpart !== undefined) {
      const { part, subpart } = args;
      const what = describeScope(part, subpart);
      // Body parts only: schedules have their own parts, often reusing labels such as "A".
      chosen = doc.outline.filter(
        (e) =>
          e.schedule === null &&
          (isWithin(e.within, part, subpart) || isScopeItself(e, part, subpart)),
      );
      scope = `Everything in ${what}.`;
      if (chosen.length === 0) {
        notes.push(
          `No ${what} was found.${scopeHint(doc.outline, part, subpart)} Omit part and subpart to see the top level.`,
        );
      } else {
        // Subpart numbers often restart in each part: say when one label matched in several.
        if (part === undefined) {
          const homes = new Set(
            chosen
              .filter((e) => e.kind === "subpart")
              .map((e) =>
                e.within
                  .filter((w) => w.kind === "part")
                  .map(describeEnclosing)
                  .join(" > "),
              ),
          );
          if (homes.size > 1) {
            notes.push(
              `Subpart ${bareLabel(String(subpart))} occurs in ${[...homes].map((h) => h || "the top level").join(", ")}; pass part as well to list just one.`,
            );
          }
        }
        if (chosen.length > MAX_ENTRIES && subpart === undefined) {
          const headings = chosen.filter((e) => e.kind === "part" || e.kind === "subpart");
          if (headings.length > 1) {
            const count = chosen.length;
            chosen = headings;
            scope = `Subparts of ${what} (it has too many entries to list at once).`;
            notes.push(
              `${what} has ${String(count)} entries, too many to list at once; pass one of the subpart labels above as subpart (with part ${bareLabel(String(part))}) to list its sections.`,
            );
          }
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
        `This document has ${String(doc.outline.length)} entries. Pass part (a part label above, with subpart for a subpart) to list its sections, or schedule (a schedule label above) to list its clauses.`,
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
