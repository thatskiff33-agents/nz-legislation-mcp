import { describe, expect, it } from "vitest";
import { diffLines, formatDiff, type DiffLine } from "../../src/text/diff.js";

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
    const many = Array.from({ length: 2100 }, (_, i) => String(i));
    expect(diffLines(many, many)).toBeNull();
  });
});
