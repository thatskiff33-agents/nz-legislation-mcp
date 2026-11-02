/** compare_versions: what changed in one provision between two versions or dates. */
import { z } from "zod";
import { readLegislation, type ReadResult } from "../text/document.js";
import { diffLines, formatDiff } from "../text/diff.js";
import { VersionIdSchema, WorkIdSchema } from "../domain/schemas.js";
import { defineTool, READ_ONLY_API_TOOL, ToolInputError, type ToolDeps } from "./shared.js";
import {
  describeTarget,
  provisionInfo,
  ProvisionInfoSchema,
  ProvisionShape,
  TEXT_SOURCE_NOTE,
  versionInfo,
  VersionInfoShape,
} from "./text-common.js";
import { selectVersion } from "./versions.js";

const MAX_DIFF_CHARS = 30_000;

const InputSchema = z
  .strictObject({
    work_id: WorkIdSchema.describe("The work to compare, from search_legislation."),
    ...ProvisionShape,
    from_as_at: z.iso.date().optional().describe("Earlier date (YYYY-MM-DD)."),
    from_version_id: VersionIdSchema.optional().describe("Or: the earlier version exactly."),
    to_as_at: z.iso
      .date()
      .optional()
      .describe("Later date (YYYY-MM-DD). Defaults to today in New Zealand."),
    to_version_id: VersionIdSchema.optional().describe("Or: the later version exactly."),
  })
  .superRefine((args, ctx) => {
    if (args.section === undefined && args.schedule === undefined) {
      ctx.addIssue({ code: "custom", message: "Provide section, schedule, or both." });
    }
    if ((args.from_as_at === undefined) === (args.from_version_id === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of from_as_at or from_version_id.",
      });
    }
    if (args.to_as_at !== undefined && args.to_version_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at most one of to_as_at or to_version_id.",
      });
    }
    for (const field of ["from_version_id", "to_version_id"] as const) {
      const id = args[field];
      if (id !== undefined && !id.startsWith(`${args.work_id}_`)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be a version of ${args.work_id}.`,
        });
      }
    }
  });

const SideSchema = z.object({ ...VersionInfoShape, found: z.boolean() });

const OutputSchema = z.object({
  work_id: z.string(),
  provision: ProvisionInfoSchema,
  from: SideSchema,
  to: SideSchema,
  same_version: z.boolean(),
  changed: z.boolean(),
  lines_added: z.number().int(),
  lines_removed: z.number().int(),
  diff: z
    .string()
    .describe('Line diff: "- " removed, "+ " added, "  " unchanged. Empty if nothing changed.'),
  diff_truncated: z.boolean(),
  notes: z.array(z.string()),
});

async function readSide(
  deps: ToolDeps,
  versionId: string,
  section: string | undefined,
  schedule: string | undefined,
  signal: AbortSignal,
): Promise<ReadResult> {
  return readLegislation(deps.xml(versionId, signal), { target: { section, schedule } });
}

export const compareVersions = defineTool({
  name: "compare_versions",
  title: "Compare a provision across versions",
  description: [
    "Show what changed in one section, schedule clause or schedule between two versions of a work, as a line diff.",
    "Give the earlier version by from_as_at or from_version_id, and the later by to_as_at or to_version_id (default today in New Zealand).",
    "Useful for 'what changed since' questions; it compares consolidated text, so check amending Acts for commencement and application details.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, deps, signal) {
    const from = await selectVersion(
      args.from_version_id === undefined
        ? { work_id: args.work_id, as_at: args.from_as_at }
        : { version_id: args.from_version_id },
      deps,
      signal,
    );
    const to = await selectVersion(
      args.to_version_id === undefined
        ? { work_id: args.work_id, as_at: args.to_as_at }
        : { version_id: args.to_version_id },
      deps,
      signal,
    );
    const notes = [TEXT_SOURCE_NOTE, ...to.notes];
    const what = describeTarget(args.section, args.schedule);
    const fromId = from.record.version_id;
    const toId = to.record.version_id;
    const same = fromId === toId;

    const before = await readSide(deps, fromId, args.section, args.schedule, signal);
    const after = same ? before : await readSide(deps, toId, args.section, args.schedule, signal);
    const found = after.found ?? before.found;
    if (found === null) {
      throw new ToolInputError(
        `${what} was not found in either version. Use get_table_of_contents to see the labels.`,
      );
    }
    if (same)
      notes.push("Both dates resolve to the same version, so nothing changed between them.");
    if (before.found === null)
      notes.push(`${what} does not exist in the earlier version (it was added).`);
    if (after.found === null)
      notes.push(`${what} does not exist in the later version (it was repealed or renumbered).`);

    const split = (text: string | null): string[] => (text === null ? [] : text.split("\n"));
    const lines = diffLines(split(before.text), split(after.text));
    if (lines === null) {
      throw new ToolInputError(
        `${what} is too long to compare line by line. Use get_provision_text on each version instead.`,
      );
    }
    const added = lines.filter((l) => l.op === "added").length;
    const removed = lines.filter((l) => l.op === "removed").length;
    const changed = added + removed > 0;
    const full = changed ? formatDiff(lines) : "";
    return {
      work_id: args.work_id,
      provision: provisionInfo(found),
      from: { ...versionInfo(from.record), found: before.found !== null },
      to: { ...versionInfo(to.record), found: after.found !== null },
      same_version: same,
      changed,
      lines_added: added,
      lines_removed: removed,
      diff: full.slice(0, MAX_DIFF_CHARS),
      diff_truncated: full.length > MAX_DIFF_CHARS,
      notes,
    };
  },
});
