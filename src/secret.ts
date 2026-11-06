/**
 * A wrapper that keeps a secret out of logs, errors, JSON and debugger output.
 *
 * The value lives in a private class field, so it is not enumerable, not serialised and not
 * shown by `util.inspect`. The only way to read it is an explicit, greppable `reveal()` call.
 */
const REDACTED = "[REDACTED]";

/**
 * The raw value plus its encodings: encodeURIComponent, form encoding (URLSearchParams, which
 * also encodes ~ ! ' ( ) * and uses + for spaces) and a WHATWG URL query (which leaves some of
 * those characters as typed). Longest first, so a longer form is never split by a shorter one.
 */
function encodedForms(value: string): string[] {
  const query = new URL("http://redact.invalid/");
  query.search = `k=${value}`;
  const forms = new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams({ k: value }).toString().slice(2),
    query.search.slice(3),
  ]);
  return [...forms].sort((a, b) => b.length - a.length);
}

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
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
    if (this.#value.length === 0) return text;
    const forms = encodedForms(this.#value);
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    return out;
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
