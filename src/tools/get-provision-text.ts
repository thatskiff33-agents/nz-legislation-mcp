/** get_provision_text: the text of one section, schedule clause or schedule. */
import { z } from "zod";
import { readLegislation } from "../text/document.js";
import {
  cleanText,
  defineTool,
  permalink,
  PermalinkSchema,
  READ_ONLY_API_TOOL,
  ToolInputError,
} from "./shared.js";
import {
  describeTarget,
  provisionInfo,
  ProvisionInfoSchema,
  ProvisionShape,
  suggestLabels,
  TEXT_SOURCE_NOTE,
  versionInfo,
  VersionInfoShape,
} from "./text-common.js";
import { refineSelector, selectVersion, VersionSelectorShape } from "./versions.js";

const DEFAULT_MAX_CHARS = 15_000;
const MAX_MAX_CHARS = 50_000;

const InputSchema = z
  .strictObject({
    ...VersionSelectorShape,
    ...ProvisionShape,
    include_history: z
      .boolean()
      .optional()
      .describe("Include amendment history notes (default false)."),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(MAX_MAX_CHARS)
      .optional()
      .describe(`Characters of text to return (default ${String(DEFAULT_MAX_CHARS)}).`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character offset to continue from (use next_offset from a previous call)."),
  })
  .superRefine((args, ctx) => {
    refineSelector(args, ctx);
    if (args.section === undefined && args.schedule === undefined) {
      ctx.addIssue({ code: "custom", message: "Provide section, schedule, or both." });
    }
  });

const OutputSchema = z.object({
  ...VersionInfoShape,
  title: z.string(),
  permalink: PermalinkSchema,
  provision: ProvisionInfoSchema,
  text: z.string(),
  offset: z.number().int(),
  next_offset: z
    .number()
    .int()
    .nullable()
    .describe("Pass as offset to get the rest, or null if this is the end."),
  total_chars: z.number().int(),
  notes: z.array(z.string()),
});

export const getProvisionText = defineTool({
  name: "get_provision_text",
  title: "Text of a provision",
  description: [
    "Get the text of one section, a clause in a schedule, or a whole schedule, from the official XML.",
    "Choose the version with work_id (+ as_at, default today in New Zealand) or version_id. Labels come from get_table_of_contents.",
    "Long text is paged: pass next_offset as offset to continue.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, deps, signal) {
    const selected = await selectVersion(args, deps, signal);
    const { record } = selected;
    const doc = await readLegislation(deps.xml(record.version_id, signal), {
      target: { section: args.section, schedule: args.schedule },
      includeHistory: args.include_history === true,
    });
    if (doc.found === null || doc.text === null) {
      const what = describeTarget(args.section, args.schedule);
      const hint =
        args.section === undefined
          ? ""
          : ` Labels near "${args.section}": ${suggestLabels(doc.outline, args.section).join(", ") || "none"}.`;
      throw new ToolInputError(
        `${what} was not found in ${record.version_id}.${hint} Use get_table_of_contents to see the labels.`,
      );
    }

    const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
    const offset = Math.min(args.offset ?? 0, doc.text.length);
    const end = Math.min(offset + maxChars, doc.text.length);
    return {
      ...versionInfo(record),
      title: cleanText(doc.title === "" ? record.title : doc.title),
      permalink: permalink(record.version_id),
      provision: provisionInfo(doc.found),
      text: doc.text.slice(offset, end),
      offset,
      next_offset: end < doc.text.length ? end : null,
      total_chars: doc.text.length,
      notes: [TEXT_SOURCE_NOTE, ...selected.notes],
    };
  },
});
