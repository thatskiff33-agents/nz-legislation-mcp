/**
 * Line-based diff (longest common subsequence). Provisions are short, so O(n*m) is fine; a
 * size guard refuses pathological inputs instead of using unbounded memory.
 */

export interface DiffLine {
  readonly op: "same" | "added" | "removed";
  readonly text: string;
}

/** Largest n*m table we will build (about 16 MB of 32-bit cells). */
const MAX_CELLS = 4_000_000;

/**
 * Diffs two line lists, or returns null if the changed region is too large to compare safely.
 * Lines common to the start and end are matched first, so a long provision with a small
 * change (e.g. one definition in a definitions section) stays cheap.
 */
export function diffLines(
  beforeAll: readonly string[],
  afterAll: readonly string[],
): DiffLine[] | null {
  let start = 0;
  while (
    start < beforeAll.length &&
    start < afterAll.length &&
    beforeAll[start] === afterAll[start]
  ) {
    start += 1;
  }
  let endBefore = beforeAll.length;
  let endAfter = afterAll.length;
  while (
    endBefore > start &&
    endAfter > start &&
    beforeAll[endBefore - 1] === afterAll[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const head = beforeAll.slice(0, start).map((text): DiffLine => ({ op: "same", text }));
  const tail = beforeAll.slice(endBefore).map((text): DiffLine => ({ op: "same", text }));
  const middle = lcsDiff(beforeAll.slice(start, endBefore), afterAll.slice(start, endAfter));
  return middle === null ? null : [...head, ...middle, ...tail];
}

function lcsDiff(before: readonly string[], after: readonly string[]): DiffLine[] | null {
  const n = before.length;
  const m = after.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // lcs[i][j] = LCS length of before[i..] and after[j..], stored row-major.
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? Number(lcs[(i + 1) * width + j + 1]) + 1
          : Math.max(Number(lcs[(i + 1) * width + j]), Number(lcs[i * width + j + 1]));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const a = String(before[i]);
    const b = String(after[j]);
    if (a === b) {
      out.push({ op: "same", text: a });
      i += 1;
      j += 1;
    } else if (Number(lcs[(i + 1) * width + j]) >= Number(lcs[i * width + j + 1])) {
      out.push({ op: "removed", text: a });
      i += 1;
    } else {
      out.push({ op: "added", text: b });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ op: "removed", text: String(before[i]) });
  for (; j < m; j += 1) out.push({ op: "added", text: String(after[j]) });
  return out;
}

const PREFIX = { same: "  ", added: "+ ", removed: "- " } as const;

/**
 * Unified-style rendering of the changes only: "- " removed, "+ " added, "  " context lines
 * around each change, and "…" between separate changes.
 */
export function formatDiff(lines: readonly DiffLine[], context = 2): string {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.op === "same") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k += 1
    ) {
      keep[k] = true;
    }
  });
  const out: string[] = [];
  let gap = false;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      gap = out.length > 0;
      return;
    }
    if (gap) out.push("…");
    gap = false;
    out.push(`${PREFIX[line.op]}${line.text}`);
  });
  return out.join("\n");
}
