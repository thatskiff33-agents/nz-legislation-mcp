import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pageBounds, safeCut, wellFormed } from "../../src/text/slice.js";

const X = "\u{1D465}"; // mathematical italic small x: two UTF-16 code units
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

describe("safeCut", () => {
  it("moves a cut off the middle of a surrogate pair", () => {
    const text = `ab${X}cd`; // a b <high> <low> c d
    expect(safeCut(text, 3)).toBe(2);
    expect(text.slice(0, safeCut(text, 3))).toBe("ab");
  });

  it("leaves other cut points alone", () => {
    const text = `ab${X}cd`;
    for (const index of [0, 1, 2, 4, 5, 6]) expect(safeCut(text, index)).toBe(index);
    expect(safeCut("plain", 3)).toBe(3);
  });
});

describe("pageBounds (the paging used by get_provision_text)", () => {
  it("clamps an offset past the end to an empty last page", () => {
    expect(pageBounds("abc", 10, 2)).toEqual({ start: 3, end: 3 });
  });

  it("moves an offset inside a character back to its start", () => {
    expect(pageBounds(`a${X}b`, 2, 5)).toEqual({ start: 1, end: 4 });
  });

  it("pages any text into pieces that join up exactly and never split a character", () => {
    const text = fc.string({ unit: fc.constantFrom(X, "é", "a", "b", " ", "\n") });
    fc.assert(
      fc.property(text, fc.integer({ min: 2, max: 40 }), (value, size) => {
        const pages: string[] = [];
        for (let offset = 0; offset < value.length;) {
          const { start, end } = pageBounds(value, offset, size);
          expect(start).toBe(offset); // offsets returned as next_offset are always safe cuts
          pages.push(value.slice(start, end));
          offset = end;
        }
        expect(pages.join("")).toBe(value);
        for (const page of pages) {
          expect(page.length).toBeGreaterThan(0);
          expect(isHigh(page.charCodeAt(page.length - 1))).toBe(false);
          expect(isLow(page.charCodeAt(0))).toBe(false);
        }
      }),
    );
  });
});

describe("wellFormed", () => {
  it("replaces lone surrogates and keeps pairs", () => {
    expect(wellFormed(`a\uD800b\uDC00c${X}`)).toBe(`a�b�c${X}`);
    expect(wellFormed("plain")).toBe("plain");
  });
});
