/** Shared pieces for the tools that read legislation text. */
import { z } from "zod";
import { cleanText, versionDate } from "./shared.js";
import type { Enclosing, Match, OutlineEntry } from "../text/document.js";
import type { VersionRecord } from "../api/client.js";

/** Upper bound for section/schedule labels supplied by the caller. */
const MAX_LABEL_LENGTH = 40;
/** Labels are short identifiers like "CA 1", "13", "6A", "YA 1": letters, digits, spaces, dots, hyphens. */
const LABEL_PATTERN = /^[A-Za-z0-9 .-]*$/;

export const LabelSchema = z
  .string()
  .trim()
  .max(MAX_LABEL_LENGTH)
  .regex(LABEL_PATTERN, { error: "Use the label as printed, e.g. 13, 6A or CA 1." });

/** A Part label: "2", "C" or "Part 2" (a subpart label is refused, with a pointer to subpart). */
export const PartSchema = LabelSchema.min(1).refine((value) => !/^subpart\b/iu.test(value), {
  error:
    'This is a subpart label: pass it as subpart (with part if you know it), e.g. subpart "1".',
});

/** A Subpart label: "1", "CB" or "Subpart 1" (a part label is refused, with a pointer to part). */
export const SubpartSchema = LabelSchema.min(1).refine((value) => !/^part\b/iu.test(value), {
  error: 'This is a part label: pass it as part, e.g. part "2".',
});

export const ProvisionShape = {
  part: PartSchema.optional().describe(
    'Only look inside this Part (label, e.g. "2" or "C"). Use it when a label appears more than once, e.g. clause numbers repeated across the parts of a schedule. For subparts use subpart.',
  ),
  subpart: SubpartSchema.optional().describe(
    'Only look inside this Subpart (label, e.g. "1" or "CB"). Subpart numbers often restart in each Part, so give part as well to pick one.',
  ),
  section: LabelSchema.min(1)
    .optional()
    .describe('Section (or clause) label as printed, e.g. "13", "6A" or "CA 1".'),
  schedule: LabelSchema.optional().describe(
    'Schedule label, e.g. "1". With section, finds a clause inside that schedule; alone, the whole schedule. Use "" for an unnumbered schedule.',
  ),
};

export const ProvisionInfoSchema = z.object({
  kind: z.enum(["section", "schedule"]),
  label: z.string(),
  heading: z.string(),
  schedule: z.string().nullable().describe("Schedule label if the provision is in a schedule."),
  repealed: z
    .boolean()
    .describe("True if this provision has been repealed (its text is just a marker)."),
  within: z
    .array(z.string())
    .describe('Enclosing parts and subparts, outermost first, e.g. ["Part 2", "Subpart 1"].'),
});

export function provisionInfo(entry: OutlineEntry): z.output<typeof ProvisionInfoSchema> {
  return {
    kind: entry.kind === "schedule" ? "schedule" : "section",
    label: cleanText(entry.label),
    heading: cleanText(entry.heading),
    schedule: entry.schedule === null ? null : cleanText(entry.schedule),
    repealed: entry.repealed,
    within: entry.within.map(describeEnclosing),
  };
}

/** "Part 2" or "Subpart 1" (labels that already carry the word are left as they are). */
export function describeEnclosing(enclosing: Enclosing): string {
  const label = cleanText(enclosing.label);
  const word = enclosing.kind === "part" ? "Part" : "Subpart";
  return label === "" || /^(?:sub)?part\b/iu.test(label) ? label || word : `${word} ${label}`;
}

/** Human description of a provision request, for messages. */
export function describeTarget(section: string | undefined, schedule: string | undefined): string {
  if (section !== undefined && schedule !== undefined) {
    return `clause ${section} of schedule ${schedule === "" ? "(unnumbered)" : schedule}`;
  }
  if (section !== undefined) return `section ${section}`;
  return `schedule ${schedule === "" || schedule === undefined ? "(unnumbered)" : schedule}`;
}

/** A note when the same label matched more than once, explaining which was used. */
export function duplicatesNote(matches: readonly Match[], chosen: OutlineEntry): string | null {
  if (matches.length < 2) return null;
  const describe = (e: OutlineEntry): string =>
    `${e.within.length > 0 ? `in ${e.within.map(describeEnclosing).join(" > ")}` : "at the top level"}${e.repealed ? " (repealed)" : ""}`;
  const list = matches.map((m) => describe(m.entry)).join("; ");
  const how =
    chosen.kind === "schedule"
      ? "Duplicated schedules are usually a repealed and a current version."
      : "Pass part (and subpart) to choose another.";
  return `This label appears ${String(matches.length)} times (${list}). Used the one ${describe(chosen)}. ${how}`;
}

/** Suggests nearby labels when a provision is not found. */
export function suggestLabels(outline: readonly OutlineEntry[], wanted: string): string[] {
  const sections = outline.filter((e) => e.kind === "section" && e.schedule === null);
  const head = String(wanted.trim().toLowerCase().split(/\s+/u)[0]);
  // Try the first word, then without trailing letters ("6b" -> "6" finds 6 and 6A).
  for (const prefix of [head, head.replace(/[a-z]+$/u, "")]) {
    if (prefix === "") continue;
    const close = sections.filter((e) => e.label.toLowerCase().startsWith(prefix));
    if (close.length > 0) return close.slice(0, 8).map((e) => e.label);
  }
  return sections.slice(0, 8).map((e) => e.label);
}

export const VersionInfoShape = {
  work_id: z.string(),
  version_id: z.string(),
  version_date: z.string().nullable(),
};

export function versionInfo(record: VersionRecord): {
  work_id: string;
  version_id: string;
  version_date: string | null;
} {
  return {
    work_id: record.work_id,
    version_id: record.version_id,
    version_date: versionDate(record.version_id),
  };
}

export const TEXT_SOURCE_NOTE =
  "Text extracted from the official XML on legislation.govt.nz. Formatting is simplified (tables as rows, graphics omitted); check the official version before relying on it.";
