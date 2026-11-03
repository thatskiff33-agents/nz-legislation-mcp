/**
 * A wrapper that keeps a secret out of logs, errors, JSON and debugger output.
 *
 * The value lives in a private class field, so it is not enumerable, not serialised and not
 * shown by `util.inspect`. The only way to read it is an explicit, greppable `reveal()` call.
 */
const REDACTED = "[REDACTED]";

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
   * Removes every occurrence of the secret, raw or URL-encoded, from arbitrary text
   * (e.g. upstream error bodies or URLs).
   */
  redact(text: string): string {
    if (this.#value.length === 0) return text;
    const forms = new Set([this.#value, encodeURIComponent(this.#value)]);
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
