/** get_provision_text: the text of one section, schedule clause or schedule. */
import { z } from "zod";
import { MemoryCache } from "../api/cache.js";
import { readLegislation, type ReadResult } from "../text/document.js";
import { pageBounds } from "../text/slice.js";
import {
  cleanText,
  defineTool,
  permalink,
  PermalinkSchema,
  READ_ONLY_API_TOOL,
  ToolInputError,
  type ToolDeps,
} from "./shared.js";
import {
  describeScope,
  describeTarget,
  scopeHint,
  duplicatesNote,
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
/** How long rendered text is kept when the optional cache is enabled. */
const TEXT_CACHE_TTL_MS = 60 * 60 * 1000;
/** Most rendered documents kept when the optional cache is enabled. */
const TEXT_CACHE_MAX_ENTRIES = 50;
/**
 * Total size budget for the optional text cache, in UTF-16 code units (about 2 bytes each, so
 * at most about 64 MB of text, less for plain ASCII). One rendered document can be up to
 * 2,000,000 characters.
 *
 * @internal Exported for tests.
 */
export const TEXT_CACHE_MAX_CHARS = 32_000_000;

/** Approximate size of a cached rendering: its text and title, plus a little per match. */
function renderedWeight(value: unknown): number {
  const rendered = value as Rendered;
  // Only renderings with text are cached; String() keeps this branch-free for a null.
  return String(rendered.text).length + rendered.title.length + rendered.matches.length * 256;
}

/** The optional rendered-text cache, bounded by entry count and by total size. */
export function createTextCache(): MemoryCache {
  return new MemoryCache(TEXT_CACHE_MAX_ENTRIES, Date.now, {
    maxWeight: TEXT_CACHE_MAX_CHARS,
    weigh: renderedWeight,
  });
}

interface Rendered {
  readonly title: string;
  readonly matches: ReadResult["matches"];
  readonly found: ReadResult["found"];
  readonly text: ReadResult["text"];
  readonly outline: ReadResult["outline"];
}

/**
 * Reads (or, with the optional cache enabled, reuses) the rendered provision, so paging
 * through a long provision does not download the whole document again for every page.
 */
async function readCached(
  deps: ToolDeps,
  versionId: string,
  args: {
    section?: string | undefined;
    schedule?: string | undefined;
    part?: string | undefined;
    subpart?: string | undefined;
    include_history?: boolean | undefined;
  },
  signal: AbortSignal,
): Promise<Rendered> {
  const key = JSON.stringify([
    versionId,
    args.section,
    args.schedule,
    args.part,
    args.subpart,
    args.include_history === true,
  ]);
  const cached = deps.textCache?.get(key) as Rendered | undefined;
  if (cached !== undefined) return cached;
  const doc = await readLegislation(deps.xml(versionId, signal), {
    target: {
      section: args.section,
      schedule: args.schedule,
      part: args.part,
      subpart: args.subpart,
    },
    includeHistory: args.include_history === true,
  });
  // Keep only what later pages need (not the outline of a successful read).
  // Duplicate matches keep their entry (for the note) but not their text, which can be large.
  const rendered: Rendered =
    doc.found === null
      ? doc
      : { ...doc, outline: [], matches: doc.matches.map((m) => ({ entry: m.entry, text: "" })) };
  if (doc.found !== null) deps.textCache?.set(key, rendered, TEXT_CACHE_TTL_MS);
  return rendered;
}

function nonNull<T>(value: T | null): T[] {
  return value === null ? [] : [value];
}
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
      .describe(
        "Character offset to continue from. To continue, pass the continue_with arguments from the previous page, so every page comes from the same version and provision.",
      ),
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
    .describe("Offset of the next page, or null if this is the end."),
  continue_with: z
    .object({
      version_id: z.string(),
      offset: z.number().int(),
      section: z.string().optional(),
      schedule: z.string().optional(),
      part: z.string().optional(),
      subpart: z.string().optional(),
      include_history: z.boolean().optional(),
    })
    .nullable()
    .describe(
      "Arguments for the next page: pass exactly these (version_id in place of work_id and as_at), so every page comes from the same version and the same provision. Null at the end.",
    ),
  total_chars: z.number().int(),
  notes: z.array(z.string()),
});

export const getProvisionText = defineTool({
  name: "get_provision_text",
  title: "Text of a provision",
  description: [
    "Get the text of one section, a clause in a schedule, or a whole schedule, from the official XML.",
    "Choose the version with work_id (+ as_at, default today in New Zealand) or version_id. Labels come from get_table_of_contents.",
    "Long text is paged: continue with the continue_with arguments from the previous page, so all pages come from one version and provision (or raise max_chars for very long provisions such as definitions sections).",
    "Repealed provisions are marked [Repealed]; quoted words appear in quotation marks.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: READ_ONLY_API_TOOL,
  async run(args, deps, signal) {
    const selected = await selectVersion(args, deps, signal);
    const { record } = selected;
    const doc = await readCached(deps, record.version_id, args, signal);
    if (doc.found === null || doc.text === null) {
      const what = describeTarget(args.section, args.schedule);
      const scoped = args.part !== undefined || args.subpart !== undefined;
      const where = scoped ? ` within ${describeScope(args.part, args.subpart)}` : "";
      const hint =
        args.section === undefined
          ? ""
          : ` Labels near "${args.section}"${scoped ? " anywhere in the document" : ""}: ${suggestLabels(doc.outline, args.section).join(", ") || "none"}.`;
      throw new ToolInputError(
        `${what} was not found${where} in ${record.version_id}.${scopeHint(doc.outline, args.part, args.subpart)}${hint} Use get_table_of_contents to see the labels.`,
      );
    }

    const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
    // Cut points never split a character; max_chars >= 1000, so a page is never empty.
    const { start: offset, end } = pageBounds(doc.text, args.offset ?? 0, maxChars);
    return {
      ...versionInfo(record),
      title: cleanText(doc.title === "" ? record.title : doc.title),
      permalink: permalink(record.version_id),
      provision: provisionInfo(doc.found),
      text: doc.text.slice(offset, end),
      offset,
      next_offset: end < doc.text.length ? end : null,
      continue_with:
        end < doc.text.length
          ? {
              version_id: record.version_id,
              offset: end,
              ...(args.section === undefined ? {} : { section: args.section }),
              ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
              ...(args.part === undefined ? {} : { part: args.part }),
              ...(args.subpart === undefined ? {} : { subpart: args.subpart }),
              ...(args.include_history === true ? { include_history: true } : {}),
            }
          : null,
      total_chars: doc.text.length,
      notes: [
        TEXT_SOURCE_NOTE,
        ...selected.notes,
        ...(doc.found.repealed
          ? ["This provision has been repealed; only a marker remains in this version."]
          : []),
        ...nonNull(duplicatesNote(doc.matches, doc.found)),
        // A later page chosen by date could come from a newer version than the first page.
        ...(offset > 0 && args.version_id === undefined
          ? [
              end < doc.text.length
                ? `This page was chosen by date (${record.version_id}). To keep every page on one version, continue with version_id ${record.version_id} (continue_with gives it), and check it matches your first page.`
                : `This page was chosen by date (${record.version_id}); check it matches your first page's version_id.`,
            ]
          : []),
      ],
    };
  },
});
