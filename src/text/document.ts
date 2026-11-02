/**
 * Streaming reader for PCO legislation XML.
 *
 * Builds a light outline (parts, subparts, cross-headings, sections, schedules) and, when asked,
 * renders one provision or schedule as plain text. It never builds a full DOM, and it stops
 * reading as soon as the requested provision is complete (unless a full outline is wanted).
 *
 * Safety: `sax` in strict mode does not expand DTD-declared or external entities (unknown
 * entities are errors), and PCO XML has no DOCTYPE. Rendered text is whitespace-normalised and
 * control characters are dropped.
 */
import sax from "sax";
import { apiErrors } from "../api/errors.js";

type OutlineKind = "part" | "subpart" | "crosshead" | "section" | "schedule";

export interface OutlineEntry {
  readonly kind: OutlineKind;
  label: string;
  heading: string;
  readonly id: string | null;
  /** Number of enclosing parts/subparts. */
  readonly depth: number;
  /** Label of the schedule this entry is in, or null for the body. */
  readonly schedule: string | null;
  /** Labels of the enclosing parts/subparts, outermost first. */
  readonly within: readonly string[];
}

/** What to render. A section is matched in the body unless `schedule` is given. */
interface Target {
  /** Section label (e.g. "CA 1", "13"); omit (with `schedule`) to render a whole schedule. */
  readonly section?: string | undefined;
  /** Schedule label (e.g. "1"); "" matches an unnumbered schedule. */
  readonly schedule?: string | undefined;
}

export interface ReadOptions {
  readonly target?: Target | undefined;
  /** Keep reading after the target to build the full outline. */
  readonly fullOutline?: boolean;
  /** Include amendment history notes in rendered text. */
  readonly includeHistory?: boolean;
}

export interface ReadResult {
  readonly title: string;
  readonly outline: readonly OutlineEntry[];
  /** Rendered text of the target, or null if it was not found (or no target was given). */
  readonly text: string | null;
  readonly found: OutlineEntry | null;
}

/** Normalises a label for comparison: case, spacing, and prefixes like "s", "section", "cl". */
export function normaliseLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^(?:sections?|clauses?|schedule|sch|cl|ss|s)\.?\s+/u, "")
    .replace(/\s+/gu, " ");
}

const OUTLINE_ELEMENTS: Readonly<Partial<Record<string, OutlineKind>>> = {
  part: "part",
  subpart: "subpart",
  crosshead: "crosshead",
  prov: "section",
  schedule: "schedule",
};

/** Subtrees never rendered: editorial aids, comparison notes, cross-reference metadata. */
const ALWAYS_SKIP = new Set(["ird.aids", "cf", "empowering-prov", "skeletons", "end"]);
/** Amendment history: rendered only on request. */
const HISTORY = new Set(["notes", "history", "amend.in"]);
/** Elements that start a new line. */
const BLOCKS = new Set([
  "subprov",
  "label-para",
  "def-para",
  "para",
  "subprov.crosshead",
  "label-para.crosshead",
  "row",
  "heading",
  "table",
  "history-note",
  "conv.body",
  "eqn-line",
  "proviso",
  "example",
  "follow-text",
]);

// eslint-disable-next-line no-control-regex -- removing control characters is the purpose
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Upper bound on rendered characters for a single provision or schedule. */
const MAX_RENDERED_CHARS = 2_000_000;

/** Accumulates rendered text as indented lines. */
class TextWriter {
  readonly #lines: string[] = [];
  #current = "";
  #indent = 0;
  #chars = 0;
  /** True when the current line holds only a "(1) " style label so far. */
  #onlyLabel = false;

  get onlyLabel(): boolean {
    return this.#onlyLabel;
  }

  /** Writes a label prefix such as "(1) "; the next paragraph continues on this line. */
  label(text: string): void {
    this.write(text);
    this.#onlyLabel = true;
  }

  get truncated(): boolean {
    return this.#chars > MAX_RENDERED_CHARS;
  }

  newline(indent: number): void {
    this.#flush();
    this.#indent = Math.max(0, indent);
  }

  write(text: string): void {
    if (this.truncated) return;
    if (text.trim() !== "") this.#onlyLabel = false;
    const clean = text.replace(CONTROL, "").replace(/\s+/gu, " ");
    if (this.#current === "") this.#current = clean.trimStart();
    else if (this.#current.endsWith(" ") && clean.startsWith(" ")) this.#current += clean.slice(1);
    else this.#current += clean;
  }

  #flush(): void {
    const line = this.#current.trim();
    this.#current = "";
    this.#onlyLabel = false;
    if (line === "") return;
    const rendered = `${"  ".repeat(this.#indent)}${line}`;
    this.#lines.push(rendered);
    this.#chars += rendered.length + 1;
  }

  finish(): string {
    this.#flush();
    const text = this.#lines.join("\n");
    return this.truncated
      ? `${text.slice(0, MAX_RENDERED_CHARS)}\n[Text truncated: this provision exceeds the rendering limit.]`
      : text;
  }
}

/** Reads legislation XML from `chunks`. */
export async function readLegislation(
  chunks: AsyncIterable<string>,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const parser = sax.parser(true, { trim: false, normalize: false });
  const outline: OutlineEntry[] = [];
  /** Element names currently open. */
  const names: string[] = [];
  /** Outline entry owned by each open element (null if none). */
  const owners: (OutlineEntry | null)[] = [];
  /** Labels of open parts/subparts (filled in when their label closes). */
  const within: string[] = [];
  /** Labels of open schedules. */
  const schedules: string[] = [];

  const wantSection =
    options.target?.section === undefined ? undefined : normaliseLabel(options.target.section);
  const wantSchedule =
    options.target?.schedule === undefined ? undefined : normaliseLabel(options.target.schedule);
  const hasTarget = wantSection !== undefined || wantSchedule !== undefined;
  const includeHistory = options.includeHistory === true;

  let title = "";
  let titleDepth = -1;
  /** Where label/heading/crosshead text is being collected, and from which depth. */
  let collect: { entry: OutlineEntry; field: "label" | "heading"; depth: number } | null = null;

  // Capture state.
  let capture: {
    entry: OutlineEntry;
    depth: number;
    confirmed: boolean;
    writer: TextWriter;
  } | null = null;
  let skipDepth = -1;
  let indent = 0;
  let inlineLabel: { text: string; parent: string; depth: number } | null = null;
  // Mutated inside parser callbacks, so kept in an object (TypeScript cannot track closures).
  const state: { found: OutlineEntry | null; text: string | null; parseError: Error | undefined } =
    { found: null, text: null, parseError: undefined };

  const matches = (entry: OutlineEntry): boolean => {
    if (wantSection !== undefined) {
      if (entry.kind !== "section" || normaliseLabel(entry.label) !== wantSection) return false;
      return wantSchedule === undefined
        ? entry.schedule === null
        : entry.schedule !== null && normaliseLabel(entry.schedule) === wantSchedule;
    }
    return entry.kind === "schedule" && normaliseLabel(entry.label) === wantSchedule;
  };

  parser.onerror = (error: Error) => {
    state.parseError ??= error;
  };

  parser.onopentag = (node) => {
    const name = node.name;
    const depth = names.length;
    const parentName = names.at(-1);
    const parentEntry = owners.at(-1) ?? null;

    if (name === "title" && parentName === "cover") titleDepth = depth;

    // Outline entries (cross-headings inside a captured provision are just rendered text).
    let entry: OutlineEntry | null = null;
    const kind = OUTLINE_ELEMENTS[name];
    if (kind !== undefined && !(kind === "crosshead" && capture !== null)) {
      const id = node.attributes["id"];
      entry = {
        kind,
        label: "",
        heading: "",
        id: typeof id === "string" ? id : null,
        depth: within.length,
        schedule: schedules.at(-1) ?? null,
        within: [...within],
      };
      outline.push(entry);
      if (kind === "part" || kind === "subpart") within.push("");
      if (kind === "schedule") schedules.push("");
      if (kind === "crosshead") collect = { entry, field: "heading", depth };
    }

    // An outline entry's own label/heading.
    if (parentEntry !== null && collect === null && (name === "label" || name === "heading")) {
      collect = { entry: parentEntry, field: name, depth };
    }

    // Start a tentative capture at each section/schedule; confirmed once its label is known.
    if (hasTarget && capture === null && state.found === null && entry !== null) {
      if (entry.kind === "section" || entry.kind === "schedule") {
        capture = { entry, depth, confirmed: false, writer: new TextWriter() };
        indent = 0;
      }
    }

    // Rendering inside a capture (below the captured element itself).
    if (capture !== null && depth > capture.depth) {
      if (skipDepth < 0 && (ALWAYS_SKIP.has(name) || (!includeHistory && HISTORY.has(name)))) {
        skipDepth = depth;
      }
      if (skipDepth < 0) {
        const w = capture.writer;
        if (name === "label-para" || name === "def-para") indent += 1;
        // A provision's heading continues its label on one header line.
        const headerHeading =
          name === "heading" && (depth === capture.depth + 1 || parentName === "prov");
        if (BLOCKS.has(name) && !headerHeading) {
          // The first paragraph after a "(1)" label continues that line; later ones start anew.
          if (!(name === "para" && w.onlyLabel)) w.newline(indent);
        }
        // A nested provision (e.g. a clause inside a schedule) starts a new header line.
        if (name === "label" && parentName === "prov") w.newline(indent);
        if (name === "brk") w.newline(indent);
        if (name === "graphic") w.write(" [graphic omitted] ");
        if (name === "entry") w.write(" | ");
        if (name === "history-note") w.write("[History] ");
        if (name === "label" && depth > capture.depth + 1) {
          inlineLabel = { text: "", parent: String(parentName), depth };
        }
      }
    }

    names.push(name);
    owners.push(entry);
  };

  parser.ontext = (raw: string) => {
    if (titleDepth >= 0) title += raw;
    if (collect !== null) collect.entry[collect.field] += raw;
    if (capture === null || skipDepth >= 0) return;
    if (inlineLabel !== null) {
      inlineLabel.text += raw;
      return;
    }
    // The captured element's own label and heading form its header line (written on close).
    const depth = names.length - 1;
    const top = names.at(-1);
    if (depth === capture.depth + 1 && (top === "label" || top === "heading")) return;
    capture.writer.write(raw);
  };

  parser.onclosetag = (name: string) => {
    names.pop();
    const entry = owners.pop() ?? null;
    const depth = names.length;

    if (depth === titleDepth) titleDepth = -1;
    if (collect !== null && depth === collect.depth) {
      const { entry: owner, field } = collect;
      owner[field] = owner[field].replace(/\s+/gu, " ").trim();
      collect = null;
      if (field === "label" && (owner.kind === "part" || owner.kind === "subpart")) {
        within[within.length - 1] = owner.label;
      }
      if (field === "label" && owner.kind === "schedule")
        schedules[schedules.length - 1] = owner.label;
    }

    if (capture !== null) {
      const w = capture.writer;
      if (depth === capture.depth + 1 && name === "label" && !capture.confirmed) {
        if (matches(capture.entry)) {
          capture.confirmed = true;
          w.newline(0);
          w.write(capture.entry.label === "" ? "" : `${capture.entry.label} `);
        } else {
          capture = null;
        }
      } else if (depth === capture.depth + 1 && name === "heading") {
        w.write(capture.entry.heading);
      } else if (inlineLabel !== null && depth === inlineLabel.depth) {
        const label = inlineLabel.text.replace(/\s+/gu, " ").trim();
        if (label !== "") {
          const bracket = inlineLabel.parent === "subprov" || inlineLabel.parent === "label-para";
          if (bracket) w.label(`(${label}) `);
          else w.write(`${label} `);
        }
        inlineLabel = null;
      }
      if (capture !== null && depth === skipDepth) skipDepth = -1;
      else if (capture !== null && skipDepth < 0) {
        if (name === "label-para" || name === "def-para") indent -= 1;
        if (name === "row") w.write(" |");
        if (name === "table") w.newline(indent);
      }
      if (capture !== null && depth === capture.depth) {
        state.found = capture.entry;
        state.text = capture.writer.finish();
        capture = null;
      }
    }

    if (entry !== null) {
      if (entry.kind === "part" || entry.kind === "subpart") within.pop();
      if (entry.kind === "schedule") schedules.pop();
    }
  };

  for await (const chunk of chunks) {
    parser.write(chunk);
    if (state.parseError !== undefined) break;
    if (state.found !== null && options.fullOutline !== true) break;
  }
  if (state.parseError === undefined && (state.found === null || options.fullOutline === true)) {
    parser.close();
  }
  if (state.parseError !== undefined && state.found === null) throw apiErrors.invalidResponse();

  return {
    title: title.replace(/\s+/gu, " ").trim(),
    outline,
    text: state.text,
    found: state.found,
  };
}
