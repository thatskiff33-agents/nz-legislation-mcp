import { describe, expect, it, vi } from "vitest";
import { createLogger, silentLogger } from "../src/logger.js";

describe("logger", () => {
  const fixed = () => new Date("2026-11-02T00:00:00.000Z");

  it("writes JSON lines at or above the threshold, redacted", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "info",
      write: (l) => lines.push(l),
      now: fixed,
      redact: (l) => l.replace("s3cret", "[REDACTED]"),
    });
    log.debug("hidden");
    log.info("hello", { token: "s3cret" });
    log.warn("careful");
    log.error("bad");
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual([
      "info",
      "warn",
      "error",
    ]);
    expect(lines[0]).toBe(
      '{"time":"2026-11-02T00:00:00.000Z","level":"info","message":"hello","token":"[REDACTED]"}\n',
    );
  });

  it("defaults to stderr and the real clock", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger({ level: "debug" }).debug("to stderr");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('"message":"to stderr"');
  });

  it("silentLogger discards everything", () => {
    const spy = vi.spyOn(process.stderr, "write");
    silentLogger.error("nothing");
    expect(spy).not.toHaveBeenCalled();
  });
});
