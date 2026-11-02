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

/** Diffs two line lists, or returns null if they are too large to compare safely. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] | null {
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

/** Unified-style rendering: "- " removed, "+ " added, "  " unchanged. */
export function formatDiff(lines: readonly DiffLine[]): string {
  const prefix = { same: "  ", added: "+ ", removed: "- " } as const;
  return lines.map((line) => `${prefix[line.op]}${line.text}`).join("\n");
}
