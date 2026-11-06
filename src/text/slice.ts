/**
 * Cutting text without splitting a character.
 *
 * JavaScript strings are UTF-16, so a character outside the Basic Multilingual Plane (for example
 * a mathematical letter) is two code units: a high surrogate then a low surrogate. Cutting between
 * them leaves half a character on each side, which renders as a replacement character.
 */

/** True for a UTF-16 high (leading) surrogate code unit. */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Returns `index`, moved back by one if it falls between the two halves of a surrogate pair.
 * Use it for every cut point (page ends, offsets and length caps) so pages join up exactly.
 */
export function safeCut(text: string, index: number): number {
  return index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

/**
 * The start and end of one page of `text`, beginning at `offset` (clamped to the text) and at
 * most `maxChars` long, with neither cut inside a character. `end` is where the next page starts;
 * with `maxChars` of at least 2, every page before the end of the text is non-empty.
 */
export function pageBounds(
  text: string,
  offset: number,
  maxChars: number,
): { readonly start: number; readonly end: number } {
  const start = safeCut(text, Math.min(offset, text.length));
  return { start, end: safeCut(text, Math.min(start + maxChars, text.length)) };
}

/** Any lone (unpaired) surrogate, which cannot be displayed; pairs are one code point under /u. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/** Replaces lone surrogates (malformed source text) with U+FFFD, the replacement character. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}
