import { describe, expect, it, vi } from "vitest";
import { createLogger, silentLogger } from "../src/logger.js";
import { Secret } from "../src/secret.js";

const fixed = () => new Date("2026-11-02T00:00:00.000Z");

function capture(redact: (t: string) => string = (t) => t) {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l), now: fixed, redact });
  return { log, lines, last: () => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  it("writes JSON lines at or above the threshold", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "info",
      write: (l) => lines.push(l),
      now: fixed,
      redact: (t) => t,
    });
    log.debug("hidden");
    log.info("hello", { a: 1 });
    log.warn("careful");
    log.error("bad");
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual([
      "info",
      "warn",
      "error",
    ]);
    expect(lines[0]).toBe(
      '{"a":1,"time":"2026-11-02T00:00:00.000Z","level":"info","message":"hello"}\n',
    );
  });

  it("redacts secrets in values, nested values, error messages and the message itself", () => {
    const secret = new Secret("s3cret-key-value");
    const { log, lines } = capture((t) => secret.redact(t));
    log.error("failed with s3cret-key-value", {
      header: "X-Api-Key: s3cret-key-value",
      nested: { deep: ["s3cret-key-value"] },
      error: new Error("boom s3cret-key-value"),
    });
    expect(lines.join("")).not.toContain("s3cret-key-value");
  });

  it("redacts a secret even when JSON escaping would change it", () => {
    const secret = new Secret('ab"cd\\ef-0123456789');
    const { log, lines } = capture((t) => secret.redact(t));
    log.info("x", { value: 'ab"cd\\ef-0123456789' });
    expect(lines.join("")).toContain("[REDACTED]");
    expect(lines.join("")).not.toContain("0123456789");
  });

  it("never lets fields spoof reserved keys", () => {
    const { log, last } = capture();
    log.info("real", { level: "error", message: "spoof", time: "never" });
    expect(last()).toMatchObject({
      level: "info",
      message: "real",
      time: "2026-11-02T00:00:00.000Z",
    });
  });

  it("serialises BigInt, Error and circular references without throwing", () => {
    const { log, last } = capture();
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    log.info("odd values", { big: 10n, err: new TypeError("bad"), circular });
    expect(last()).toMatchObject({
      big: "10",
      err: { name: "TypeError", message: "bad" },
      circular: { name: "loop", self: "[Circular]" },
    });
  });

  it("prints a repeated (non-circular) object in full each time", () => {
    const { log, last } = capture();
    const shared = { a: 1 };
    log.info("twice", { first: shared, second: shared, list: [shared, shared] });
    expect(last()).toMatchObject({ first: { a: 1 }, second: { a: 1 }, list: [{ a: 1 }, { a: 1 }] });
  });

  it("keeps values with their own toJSON, such as dates", () => {
    const { log, last } = capture();
    log.info("dated", { at: new Date("2026-01-02T03:04:05.000Z") });
    expect(last()).toMatchObject({ at: "2026-01-02T03:04:05.000Z" });
  });

  it("falls back safely when serialisation still fails", () => {
    const { log, last } = capture();
    const hostile = {
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(() => {
      log.warn("hostile", { hostile });
    }).not.toThrow();
    expect(last()).toEqual({
      time: "2026-11-02T00:00:00.000Z",
      level: "warn",
      message: "hostile",
      fields: "[unserialisable]",
    });
  });

  it("defaults to stderr and the real clock", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger({ level: "debug", redact: (t) => t }).debug("to stderr");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('"message":"to stderr"');
  });

  it("silentLogger discards everything", () => {
    const spy = vi.spyOn(process.stderr, "write");
    silentLogger.error("nothing");
    expect(spy).not.toHaveBeenCalled();
  });
});
