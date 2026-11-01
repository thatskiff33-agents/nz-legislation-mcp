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

  /** Removes every occurrence of the secret from arbitrary text (e.g. upstream error bodies). */
  redact(text: string): string {
    return this.#value.length === 0 ? text : text.split(this.#value).join(REDACTED);
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
