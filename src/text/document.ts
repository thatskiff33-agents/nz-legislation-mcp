/**
 * Streaming reader for PCO legislation XML.
 *
 * Builds a light outline (parts, subparts, cross-headings, sections, schedules) and, when asked,
 * renders a provision or schedule as plain text. It never builds a full DOM, and it stops
 * reading once it has what it needs (unless a full outline is wanted).
 *
 * Fidelity rules (checked against the full GST Act 1985 and Income Tax Act 2007):
 *  - quoted statutory words (amend.in / quote.in with quote="1") are kept, in quotation marks;
 *  - repealed elements (deletion-status="repealed") are marked "[Repealed]";
 *  - labels of subsections, paragraphs, list items and formula variables lead their own line;
 *  - amending-Act skeletons, quoted amendments and schedule amendment tables are not part of
 *    the outline, so they can never be returned as if they were sections of this Act;
 *  - editorial aids, comparison notes and table summaries are not rendered; amendment history
 *    only on request.
 *
 * Safety: `sax` in strict mode does not expand DTD-declared or external entities, and PCO XML has
 * no DOCTYPE. Rendered text is whitespace-normalised and control characters are dropped.
 */
import sax from "sax";
import { xmlErrors } from "../api/errors.js";
import { safeCut, wellFormed } from "./slice.js";

type OutlineKind = "part" | "subpart" | "crosshead" | "section" | "schedule";

export interface OutlineEntry {
  readonly kind: OutlineKind;
  label: string;
  heading: string;
  readonly id: string | null;
  /** True if marked repealed in the XML (deletion-status="repealed"). */
  readonly repealed: boolean;
  /** Number of enclosing parts/subparts. */
  readonly depth: number;
  /** Label of the schedule this entry is in, or null for the body. */
  readonly schedule: string | null;
  /** Labels of the enclosing parts/subparts, outermost first (shared, do not mutate). */
  readonly within: readonly string[];
}

/** What to render. A section is matched in the body unless `schedule` is given. */
interface Target {
  /** Section label (e.g. "CA 1", "13"); omit (with `schedule`) to render a whole schedule. */
  readonly section?: string | undefined;
  /** Schedule label (e.g. "1"); "" matches an unnumbered schedule. */
  readonly schedule?: string | undefined;
  /** Only match inside this part or subpart (label). */
  readonly part?: string | undefined;
}

export interface ReadOptions {
  readonly target?: Target | undefined;
  /** Keep reading to the end to build the full outline. */
  readonly fullOutline?: boolean;
  /** Include amendment history notes in rendered text. */
  readonly includeHistory?: boolean;
}

export interface Match {
  readonly entry: OutlineEntry;
  readonly text: string;
}

export interface ReadResult {
  readonly title: string;
  readonly outline: readonly OutlineEntry[];
  /** Every match found, in document order (more than one means the label is duplicated). */
  readonly matches: readonly Match[];
  /** The preferred match: the first that is not repealed, else the first. Null if none. */
  readonly found: OutlineEntry | null;
  readonly text: string | null;
}

/**
 * Normalises a label for comparison: case, spacing, a trailing dot, and a prefix word such as
 * "section", "clause", "schedule", "sch" or "s" ("s 13", "s13", "section CB 6"). Two-letter
 * abbreviations such as "cl" and "ss" are not stripped, because they are real labels in some
 * Acts (e.g. "CL 1" in the Income Tax Act 2007).
 *
 * @internal Exported for tests.
 */
export function normaliseLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/\.$/u, "")
    .replace(/^(?:sections?|clauses?|schedule|sch|s)(?:\.?\s+|(?=\d))/u, "");
}

/** Normalises a part/subpart label, accepting forms like "Part C" or "subpart CB". */
export function normalisePartLabel(label: string): string {
  return normaliseLabel(label.trim().replace(/^(?:sub)?part\s+/iu, ""));
}

const OUTLINE_ELEMENTS: Readonly<Partial<Record<string, OutlineKind>>> = {
  part: "part",
  subpart: "subpart",
  crosshead: "crosshead",
  "ird-crosshead": "crosshead",
  prov: "section",
  head1: "part",
  schedule: "schedule",
};

/** Subtrees whose provisions are not provisions of this Act (amending Acts, quoted amendments). */
const NOT_THIS_ACT = new Set([
  "end",
  "skeletons",
  "amend",
  "quote.in",
  "schedule.amendments",
  "schedule.amendments.group",
  "notes",
  "history",
]);

/** Inline elements whose quote="1" means "show these words in quotation marks". */
const INLINE_QUOTES = new Set(["amend.in", "quote.in"]);

/** Subtrees never rendered: editorial aids, comparison notes, table summaries, metadata. */
const ALWAYS_SKIP = new Set([
  "ird.aids",
  "cf",
  "skeletons",
  "end",
  "summary",
  "contents",
  "editorial-note",
]);
/** Amendment history: rendered only on request. */
const HISTORY = new Set(["notes", "history"]);
/** Elements that start a new line. */
const BLOCKS = new Set([
  "subprov",
  "label-para",
  "def-para",
  "para",
  "subprov.crosshead",
  "label-para.crosshead",
  "crosshead",
  "ird-crosshead",
  "row",
  "heading",
  "table",
  "history-note",
  "conv.body",
  "conv.end",
  "signature-block",
  "sig.para",
  "eqn-line",
  "proviso",
  "example",
  "follow-text",
  "item",
  "variable-def",
  "head1",
  "head2",
  "head3",
  "head4",
  "head5",
  "part",
  "subpart",
]);
/** Elements whose own <label> leads their line as "(1) ". */
const BRACKET_LABEL_PARENTS = new Set(["subprov", "label-para"]);
/** Elements whose own <label> (or <variable>) leads their line as plain text, e.g. "2 ", "a ". */
const PLAIN_LABEL_PARENTS = new Set(["item", "variable-def"]);
/** Elements whose heading continues the label on the same line. */
const HEADER_PARENTS = new Set(["prov", "schedule", "head1", "part", "subpart"]);
/** Elements whose first child is a label, so "[Repealed]" follows the label. */
const LABELLED = new Set([
  "prov",
  "subprov",
  "label-para",
  "schedule",
  "part",
  "subpart",
  "head1",
  "item",
]);

// eslint-disable-next-line no-control-regex -- removing control characters is the purpose
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * Zero-width and byte-order-mark characters (U+FEFF appears inside some citations), and
 * bidirectional embedding, override and isolate controls, which could make displayed text read
 * differently from its characters.
 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/gu;

/** Punctuation that ends or continues the current line rather than starting new words. */
const CLOSING_PUNCTUATION = /^[.,;:!?)\]}”’–—-]/u;

/** Upper bound on rendered characters for a single provision or schedule. */
const MAX_RENDERED_CHARS = 2_000_000;
/** Upper bound on matches collected for a duplicated label. */
const MAX_MATCHES = 25;

/** Accumulates rendered text as indented lines. */
class TextWriter {
  readonly #lines: string[] = [];
  #current = "";
  #indent = 0;
  #chars = 0;
  /** True when the current line holds only a label prefix so far. */
  #onlyLabel = false;
  /** Indent of a line break that the next real words should start with (see breakBeforeText). */
  #pending: number | undefined;

  get truncated(): boolean {
    return this.#chars + this.#current.length > MAX_RENDERED_CHARS;
  }

  get onlyLabel(): boolean {
    return this.#onlyLabel;
  }

  newline(indent: number): void {
    this.#pending = undefined;
    this.#flush();
    this.#indent = Math.max(0, indent);
  }

  /**
   * After a block closes, words that follow it (closing words after a list, text after a
   * signature line) start a new line at `indent`. The break is applied lazily, only if real
   * words follow, so punctuation that belongs to the block's line is not stranded.
   */
  breakBeforeText(indent: number): void {
    this.#pending = indent;
  }

  /**
   * Writes punctuation that ends the current line, such as a closing quotation mark or a table
   * cell separator. It cancels any pending break: what follows continues this line.
   */
  append(text: string): void {
    this.#pending = undefined;
    this.write(text);
  }

  /** Writes a marker on the current line, leaving any pending break for the words after it. */
  mark(text: string): void {
    const pending = this.#pending;
    this.#pending = undefined;
    this.write(text);
    this.#pending = pending;
  }

  write(text: string): void {
    if (this.truncated) return;
    const clean = text.replace(CONTROL, "").replace(INVISIBLE, "").replace(/\s+/gu, " ");
    const first = clean.trimStart().charAt(0);
    if (this.#pending !== undefined && first !== "") {
      if (!CLOSING_PUNCTUATION.test(first)) {
        // Words, or an opening quotation mark or bracket, start the new line.
        this.newline(this.#pending);
      } else if (/[\p{L}\p{N}]/u.test(clean)) {
        // "; and" or ", or": punctuation that continues this line, with words after it.
        this.#pending = undefined;
      }
      // Bare closing punctuation (".") stays on this line and the break stays pending.
    }
    if (clean.trim() !== "") this.#onlyLabel = false;
    if (this.#current === "") this.#current = clean.trimStart();
    else if (this.#current.endsWith(" ") && clean.startsWith(" ")) this.#current += clean.slice(1);
    else this.#current += clean;
    // Enforce the cap inside a line too: one huge text node must not grow without bound.
    const room = MAX_RENDERED_CHARS + 1 - this.#chars;
    if (this.#current.length > room) {
      this.#current = this.#current.slice(0, safeCut(this.#current, Math.max(0, room)));
    }
  }

  /** Writes a label prefix such as "(1) "; the next paragraph continues on this line. */
  label(text: string): void {
    this.write(text);
    this.#onlyLabel = true;
  }

  #flush(): void {
    const line = this.#current.trim();
    this.#current = "";
    this.#onlyLabel = false;
    // Skip empty lines, including table rows with no content ("|").
    if (line === "" || line === "|") return;
    const rendered = `${"  ".repeat(this.#indent)}${line}`;
    this.#lines.push(rendered);
    this.#chars += rendered.length + 1;
  }

  finish(): string {
    this.#flush();
    // Repaired here, on the whole text, because the parser can split a valid pair across two
    // text events; per-event repair would corrupt it.
    const text = wellFormed(this.#lines.join("\n"));
    return this.truncated
      ? `${text.slice(0, safeCut(text, MAX_RENDERED_CHARS))}\n[Text truncated: this provision exceeds the rendering limit.]`
      : text;
  }
}

interface Capture {
  readonly entry: OutlineEntry;
  readonly depth: number;
  confirmed: boolean;
  readonly writer: TextWriter;
  /** Whether "[Repealed]" still needs writing for the captured element itself. */
  repealedPending: boolean;
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
  /** Text to write when each open element closes (closing quotation marks). */
  const closers: string[] = [];
  /** Whether each open element is repealed. */
  const repealedFlags: boolean[] = [];
  /** Labels of open parts/subparts (filled in when their label closes). */
  const within: string[] = [];
  let withinSnapshot: readonly string[] = [];
  let withinDirty = false;
  /** Labels of open schedules. */
  const schedules: string[] = [];

  const target = options.target;
  const wantSection = target?.section === undefined ? undefined : normaliseLabel(target.section);
  const wantSchedule = target?.schedule === undefined ? undefined : normaliseLabel(target.schedule);
  const wantPart = target?.part === undefined ? undefined : normalisePartLabel(target.part);
  const hasTarget = wantSection !== undefined || wantSchedule !== undefined;
  const includeHistory = options.includeHistory === true;

  let title = "";
  let titleDepth = -1;
  /** Depth of the outermost open element that is not part of this Act (-1 if none). */
  let notThisActDepth = -1;
  /** Where label/heading/crosshead text is being collected, and from which depth. */
  let collect: { entry: OutlineEntry; field: "label" | "heading"; depth: number } | null = null;

  let capture: Capture | null = null;
  let headerDepth = -1;
  let skipDepth = -1;
  let quoteDepth = -1;
  /** A schedule's empowering provision: collected, then shown after the header line. */
  let empoweringDepth = -1;
  let empoweringText = "";
  let empoweringPending = false;
  let headerDone = false;
  let indent = 0;
  let inlineLabel: { text: string; parent: string; depth: number; repealed: boolean } | null = null;

  // Mutated inside parser callbacks, so kept in an object (TypeScript cannot track closures).
  const state: {
    matches: Match[];
    parseError: Error | undefined;
    stop: boolean;
    /** Schedule nesting level whose clauses are being collected, to stop at its end. */
    scheduleScope: number;
  } = { matches: [], parseError: undefined, stop: false, scheduleScope: -1 };

  const currentWithin = (): readonly string[] => {
    if (withinDirty) {
      withinSnapshot = [...within];
      withinDirty = false;
    }
    return withinSnapshot;
  };

  const matches = (entry: OutlineEntry): boolean => {
    if (wantPart !== undefined && !entry.within.some((l) => normalisePartLabel(l) === wantPart)) {
      return false;
    }
    if (wantSection !== undefined) {
      if (entry.kind !== "section" || normaliseLabel(entry.label) !== wantSection) return false;
      return wantSchedule === undefined
        ? entry.schedule === null
        : entry.schedule !== null && normaliseLabel(entry.schedule) === wantSchedule;
    }
    return entry.kind === "schedule" && normaliseLabel(entry.label) === wantSchedule;
  };

  const writeEmpowering = (w: TextWriter): void => {
    const text = empoweringText.replace(/\s+/gu, " ").trim();
    empoweringText = "";
    empoweringPending = false;
    if (text === "") return;
    w.newline(0);
    w.write(`[Empowering provision: ${text}]`);
  };
  const resetEmpowering = (): void => {
    empoweringDepth = -1;
    empoweringText = "";
    empoweringPending = false;
    headerDone = false;
  };

  parser.onerror = (error: Error) => {
    state.parseError ??= error;
  };

  parser.onopentag = (node) => {
    const name = node.name;
    const depth = names.length;
    const parentName = names.at(-1);
    const parentEntry = owners.at(-1) ?? null;
    const repealed = node.attributes["deletion-status"] === "repealed";
    // Quotation marks for inline quoted words only (whole quoted provisions in amending
    // schedules also carry quote="1" on every element), and never nested.
    const quoted = node.attributes["quote"] === "1" && INLINE_QUOTES.has(name) && quoteDepth < 0;

    if (name === "title" && parentName === "cover") titleDepth = depth;
    if (notThisActDepth < 0 && NOT_THIS_ACT.has(name)) notThisActDepth = depth;

    // Outline entries (cross-headings inside a captured provision are just rendered text).
    let entry: OutlineEntry | null = null;
    const kind = OUTLINE_ELEMENTS[name];
    if (kind !== undefined && notThisActDepth < 0 && !(kind === "crosshead" && capture !== null)) {
      const id = node.attributes["id"];
      entry = {
        kind,
        label: "",
        heading: "",
        id: typeof id === "string" ? id : null,
        repealed,
        depth: within.length,
        schedule: schedules.at(-1) ?? null,
        within: currentWithin(),
      };
      outline.push(entry);
      if (kind === "part" || kind === "subpart") {
        within.push("");
        withinDirty = true;
      }
      if (kind === "schedule") schedules.push("");
      if (kind === "crosshead") collect = { entry, field: "heading", depth };
    }

    // An outline entry's own label/heading.
    if (parentEntry !== null && collect === null && (name === "label" || name === "heading")) {
      collect = { entry: parentEntry, field: name, depth };
    }

    // Start a tentative capture at each section/schedule; confirmed once its label is known.
    if (hasTarget && capture === null && !state.stop && entry !== null) {
      if (entry.kind === "section" || entry.kind === "schedule") {
        capture = {
          entry,
          depth,
          confirmed: false,
          writer: new TextWriter(),
          repealedPending: repealed,
        };
        indent = 0;
        resetEmpowering();
      }
    }

    let closer = "";
    if (capture !== null && depth > capture.depth) {
      const w = capture.writer;
      // The captured element's own label and heading form its header line.
      if (depth === capture.depth + 1 && (name === "label" || name === "heading")) {
        headerDepth = depth;
      }
      if (skipDepth < 0 && (ALWAYS_SKIP.has(name) || (!includeHistory && HISTORY.has(name)))) {
        skipDepth = depth;
      }
      if (name === "empowering-prov" && skipDepth < 0) empoweringDepth = depth;
      if (skipDepth < 0 && headerDepth < 0) {
        if (name === "label-para" || name === "def-para") indent += 1;
        const continuesHeader = name === "heading" && HEADER_PARENTS.has(String(parentName));
        if (BLOCKS.has(name) && !continuesHeader) {
          // The first paragraph after a "(1)" label continues that line; later ones start anew.
          if (!(name === "para" && w.onlyLabel)) w.newline(indent);
        }
        if (name === "label" && parentName === "prov") w.newline(indent);
        if (name === "brk") w.newline(indent);
        // The marker stays on its figure heading's line ("Flowchart B3 ... [graphic omitted]").
        if (name === "graphic") w.mark(" [graphic omitted] ");
        // A cell separator continues the row's line, even after a list inside the previous cell.
        if (name === "entry") w.append(" | ");
        if (name === "history-note") w.write("[History] ");
        // The marker leads the element's line; its first paragraph continues on that line.
        if (repealed && !LABELLED.has(name)) w.label("[Repealed] ");
        if (quoted) {
          w.write("“");
          closer = "”";
          quoteDepth = depth;
        }

        const parentRepealed = repealedFlags.at(-1) === true;
        if (name === "label" && depth > capture.depth + 1) {
          inlineLabel = { text: "", parent: String(parentName), depth, repealed: parentRepealed };
        }
        if (name === "variable" && parentName === "variable-def") {
          inlineLabel = { text: "", parent: "variable-def", depth, repealed: parentRepealed };
        }
      }
    }

    names.push(name);
    owners.push(entry);
    closers.push(closer);
    repealedFlags.push(repealed);
  };

  parser.ontext = (raw: string) => {
    if (titleDepth >= 0) title += raw;
    if (collect !== null) collect.entry[collect.field] += raw;
    if (capture === null || skipDepth >= 0 || headerDepth >= 0) return;
    if (empoweringDepth >= 0) {
      empoweringText += raw;
      return;
    }
    if (inlineLabel !== null) {
      inlineLabel.text += raw;
      return;
    }
    capture.writer.write(raw);
  };

  parser.onclosetag = (name: string) => {
    names.pop();
    const entry = owners.pop() ?? null;
    const closer = String(closers.pop());
    repealedFlags.pop();
    const depth = names.length;

    if (depth === titleDepth) titleDepth = -1;
    if (depth === notThisActDepth) notThisActDepth = -1;
    if (collect !== null && depth === collect.depth) {
      const { entry: owner, field } = collect;
      owner[field] = owner[field].replace(/\s+/gu, " ").trim();
      collect = null;
      if (field === "label" && (owner.kind === "part" || owner.kind === "subpart")) {
        within[within.length - 1] = owner.label;
        withinDirty = true;
      }
      if (field === "label" && owner.kind === "schedule") {
        schedules[schedules.length - 1] = owner.label;
      }
    }

    if (capture !== null) {
      const w = capture.writer;
      if (depth === headerDepth) {
        headerDepth = -1;
        if (name === "label" && !capture.confirmed) {
          if (matches(capture.entry)) {
            capture.confirmed = true;
            w.newline(0);
            if (capture.entry.label !== "") w.write(`${capture.entry.label} `);
          } else {
            capture = null;
          }
        } else if (name === "heading" && capture.confirmed) {
          w.write(capture.entry.heading);
          if (capture.repealedPending) {
            w.write(" [Repealed]");
            capture.repealedPending = false;
          }
          headerDone = true;
          if (empoweringPending) writeEmpowering(w);
        }
      } else if (inlineLabel !== null && depth === inlineLabel.depth) {
        const label = inlineLabel.text.replace(/\s+/gu, " ").trim();
        const suffix = inlineLabel.repealed ? "[Repealed] " : "";
        if (BRACKET_LABEL_PARENTS.has(inlineLabel.parent)) {
          w.label(`${label === "" ? "" : `(${label}) `}${suffix}`);
        } else if (PLAIN_LABEL_PARENTS.has(inlineLabel.parent)) {
          w.label(`${label === "" ? "" : `${label} `}${suffix}`);
        } else {
          const isPart = inlineLabel.parent === "part" || inlineLabel.parent === "subpart";
          const partWord =
            isPart && label !== "" && !/^(?:sub)?part\b/iu.test(label)
              ? `${inlineLabel.parent === "part" ? "Part" : "Subpart"} `
              : "";
          w.write(`${label === "" ? "" : `${partWord}${label} `}${suffix}`);
        }
        inlineLabel = null;
      }
      if (capture !== null && depth === empoweringDepth) {
        empoweringDepth = -1;
        if (headerDone) writeEmpowering(w);
        else empoweringPending = true;
      }
      if (capture !== null && depth === skipDepth) skipDepth = -1;
      else if (capture !== null && skipDepth < 0 && headerDepth < 0) {
        if (name === "row") w.append(" |");
        if (name === "table") w.newline(indent);
        if (closer !== "") w.append(closer);
        // Words after a block (closing words such as "shall be deemed ..." after a list of
        // paragraphs, text after a list item or signature line) belong to the enclosing element:
        // they start a new line at its indent instead of running on. Blocks that follow already
        // start their own line, so only loose words are affected.
        if (name === "label-para" || name === "def-para") indent -= 1;
        if (BLOCKS.has(name)) w.breakBeforeText(indent);
        if (depth === quoteDepth) quoteDepth = -1;
      }
      if (capture !== null && depth === capture.depth) {
        // Only an element whose label was checked can match (an element with no <label> never
        // confirms, so it can never be returned for an arbitrary target).
        if (capture.confirmed) {
          if (capture.repealedPending) {
            w.newline(0);
            w.write("[Repealed]");
          }
          state.matches.push({ entry: capture.entry, text: w.finish() });
          // Clauses can repeat across parts of one schedule: read to the end of that schedule.
          if (capture.entry.kind === "section" && capture.entry.schedule !== null) {
            state.scheduleScope = schedules.length;
          }
        }
        capture = null;
        resetEmpowering();
      }
    }

    if (entry !== null) {
      if (entry.kind === "part" || entry.kind === "subpart") {
        within.pop();
        withinDirty = true;
      }
      if (entry.kind === "schedule") {
        if (schedules.length === state.scheduleScope) state.scheduleScope = -1;
        schedules.pop();
      }
    }
    // Stop once a live match is found (and any schedule being scanned for duplicate clause
    // numbers has ended), or enough matches are collected.
    const live = state.matches.some((m) => !m.entry.repealed);
    const wholeSchedule = wantSection === undefined;
    if (
      state.matches.length >= MAX_MATCHES ||
      (live && state.scheduleScope < 0 && !wholeSchedule)
    ) {
      state.stop = true;
    }
  };

  for await (const chunk of chunks) {
    parser.write(chunk);
    if (state.parseError !== undefined) break;
    if (state.stop && options.fullOutline !== true) break;
  }
  const stoppedEarly = state.stop && options.fullOutline !== true;
  if (state.parseError === undefined && !stoppedEarly) parser.close();
  if (state.parseError !== undefined && state.matches.length === 0) {
    throw xmlErrors.unreadable();
  }

  const preferred = state.matches.find((m) => !m.entry.repealed) ?? state.matches[0];
  return {
    title: title.replace(/\s+/gu, " ").trim(),
    outline,
    matches: state.matches,
    found: preferred?.entry ?? null,
    text: preferred?.text ?? null,
  };
}
