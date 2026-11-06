import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffLines, formatDiff, type DiffLine } from "../../src/text/diff.js";

describe("diffLines (properties)", () => {
  // Small alphabets make shared lines likely, so the diff has real work to do.
  const lines = fc.array(fc.constantFrom("a", "b", "c", "d", ""), { maxLength: 30 });

  it("keeps every line: dropping additions gives before, dropping removals gives after", () => {
    fc.assert(
      fc.property(lines, lines, (before, after) => {
        const result = diffLines(before, after);
        expect(result).not.toBeNull();
        const out = result ?? [];
        expect(out.filter((l) => l.op !== "added").map((l) => l.text)).toEqual(before);
        expect(out.filter((l) => l.op !== "removed").map((l) => l.text)).toEqual(after);
      }),
    );
  });

  it("reports no changes for identical input", () => {
    fc.assert(
      fc.property(lines, (same) => {
        const result = diffLines(same, [...same]);
        expect(result).not.toBeNull();
        expect((result ?? []).every((l) => l.op === "same")).toBe(true);
      }),
    );
  });
});

function diff(before: string[], after: string[]): DiffLine[] {
  const lines = diffLines(before, after);
  if (lines === null) throw new Error("unexpectedly too large");
  return lines;
}

describe("diffLines", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(formatDiff(diff(["a", "b", "c"], ["a", "c", "d"]))).toBe("  a\n- b\n  c\n+ d");
  });

  it("adds before a common line when that keeps the match", () => {
    expect(formatDiff(diff(["a"], ["b", "a"]))).toBe("+ b\n  a");
  });

  it("handles empty sides", () => {
    expect(diff([], ["x"])).toEqual([{ op: "added", text: "x" }]);
    expect(diff(["x"], [])).toEqual([{ op: "removed", text: "x" }]);
    expect(diff([], [])).toEqual([]);
  });

  it("prefers removal then addition for a replaced line", () => {
    expect(formatDiff(diff(["old"], ["new"]))).toBe("- old\n+ new");
  });

  it("returns null instead of using too much memory", () => {
    const before = Array.from({ length: 2100 }, (_, i) => `old ${String(i)}`);
    const after = Array.from({ length: 2100 }, (_, i) => `new ${String(i)}`);
    expect(diffLines(before, after)).toBeNull();
  });

  it("matches common start and end lines before diffing the middle", () => {
    const same = Array.from({ length: 3000 }, (_, i) => String(i));
    const changed = [...same.slice(0, 1500), "x", ...same.slice(1501)];
    const lines = diff(same, changed);
    expect(lines.filter((l) => l.op !== "same")).toEqual([
      { op: "removed", text: "1500" },
      { op: "added", text: "x" },
    ]);
  });

  it("shows only changes with context, separating distant changes", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
    const after = ["1", "two", "3", "4", "5", "6", "7", "8", "nine", "10"];
    expect(formatDiff(diff(before, after))).toBe(
      "  1\n- 2\n+ two\n  3\n  4\n…\n  7\n  8\n- 9\n+ nine\n  10",
    );
  });
});
