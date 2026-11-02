import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InputCancelledError, readAll, readSecret, type Input } from "../../src/cli/terminal.js";

function fakeInput(
  tty: boolean,
): Input & { emit: (event: string, value?: unknown) => boolean; raw: boolean[] } {
  const emitter = new EventEmitter();
  const raw: boolean[] = [];
  return Object.assign(emitter, {
    isTTY: tty,
    raw,
    setRawMode: tty ? (mode: boolean) => raw.push(mode) : undefined,
    setEncoding: () => undefined,
    resume: vi.fn(),
    pause: vi.fn(),
  }) as never;
}

describe("readSecret", () => {
  it("reads hidden input on a terminal, handling backspace and ignoring control characters", async () => {
    const input = fakeInput(true);
    const out: string[] = [];
    const result = readSecret("Key: ", input, (t) => out.push(t));
    input.emit("data", "abcX\u007fd\u0001e");
    input.emit("data", "f\rignored");
    expect(await result).toBe("abcdef");
    expect(input.raw).toEqual([true, false]);
    expect(out).toEqual(["Key: ", "\n"]); // the key itself is never written
  });

  it("supports backspace as \\b and newline as \\n", async () => {
    const input = fakeInput(true);
    const result = readSecret("", input, () => undefined);
    input.emit("data", "xy\bz\n");
    expect(await result).toBe("xz");
  });

  it("cancels on Ctrl-C", async () => {
    const input = fakeInput(true);
    const result = readSecret("", input, () => undefined);
    input.emit("data", "ab\u0003");
    await expect(result).rejects.toBeInstanceOf(InputCancelledError);
  });

  it("reads a line without a terminal, and accepts end of input", async () => {
    const input = fakeInput(false);
    const result = readSecret("", input, () => undefined);
    input.emit("data", "piped-key");
    input.emit("end");
    expect(await result).toBe("piped-key");
  });
});

describe("readAll", () => {
  it("collects all input", async () => {
    const input = fakeInput(false);
    const result = readAll(input);
    input.emit("data", "a");
    input.emit("data", "b");
    input.emit("end");
    expect(await result).toBe("ab");
  });

  it("rejects on a stream error", async () => {
    const input = fakeInput(false);
    const result = readAll(input);
    input.emit("error", new Error("broken pipe"));
    await expect(result).rejects.toThrow("broken pipe");
    const other = readAll(input);
    input.emit("error", "odd");
    await expect(other).rejects.toThrow("odd");
  });
});
