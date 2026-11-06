/**
 * A wrapper that keeps a secret out of logs, errors, JSON and debugger output.
 *
 * The value lives in a private class field, so it is not enumerable, not serialised and not
 * shown by `util.inspect`. The only way to read it is an explicit, greppable `reveal()` call.
 */
const REDACTED = "[REDACTED]";

/**
 * The raw value plus the ways it is commonly encoded: encodeURIComponent, encodeURI, double
 * encoding, form encoding (URLSearchParams, which also encodes ~ ! ' ( ) and uses + for spaces),
 * a WHATWG URL query (which leaves some characters as typed), and JSON escapes some serialisers
 * add (\/ and Go-style < > &).
 */
function encodedForms(value: string): string[] {
  const query = new URL("http://redact.invalid/");
  query.search = `k=${value}`;
  const component = encodeURIComponent(value);
  return [
    ...new Set([
      value,
      component,
      encodeURI(value),
      encodeURIComponent(component),
      new URLSearchParams({ k: value }).toString().slice(2),
      query.search.slice(3),
      value.replaceAll("/", "\\/"),
      value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"),
    ]),
  ];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A regular-expression source for one form, with percent-escape hex digits in either case. */
function formPattern(form: string): string {
  return form
    .split(/(%[0-9A-F]{2})/u)
    .map((part, index) =>
      index % 2 === 1
        ? part.replace(/[A-F]/gu, (digit) => `[${digit}${digit.toLowerCase()}]`)
        : escapeRegExp(part),
    )
    .join("");
}

/**
 * One pattern matching every form, longest first so a longer form is never split by a shorter
 * one. Not covered: a double-encoded key re-written with lower-case hex inside the outer escape.
 */
function redactionPattern(value: string): RegExp {
  const forms = encodedForms(value).sort((a, b) => b.length - a.length);
  return new RegExp(forms.map(formPattern).join("|"), "gu");
}

export class Secret {
  readonly #value: string;
  /** Built once: redaction runs on every log record. Undefined for an empty secret. */
  readonly #pattern: RegExp | undefined;

  constructor(value: string) {
    this.#value = value;
    this.#pattern = value.length === 0 ? undefined : redactionPattern(value);
  }

  /** Returns the raw secret. Call only at the point of use (the outgoing request header). */
  reveal(): string {
    return this.#value;
  }

  /**
   * Removes every occurrence of the secret from arbitrary text (e.g. upstream error bodies or
   * URLs): the raw value and each way it is commonly encoded in a URL or form body.
   */
  redact(text: string): string {
    return this.#pattern === undefined ? text : text.replace(this.#pattern, REDACTED);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${REDACTED})`;
  }
}
