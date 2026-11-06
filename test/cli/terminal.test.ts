import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  InputCancelledError,
  InputNotHiddenError,
  TerminalReadError,
  readPiped,
  readSecret,
  type Input,
} from "../../src/cli/terminal.js";

function fakeInput(tty: boolean): Input & {
  emit: (event: string, value?: unknown) => boolean;
  listenerCount: (event: string) => number;
  raw: boolean[];
} {
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

  it("strips bracketed-paste markers from a pasted key", async () => {
    const input = fakeInput(true);
    const result = readSecret("", input, () => undefined);
    input.emit("data", "\u001b[200~my-key\u001b[201~\r");
    expect(await result).toBe("my-key");
  });

  it("fails (and restores the terminal) if the input stream fails", async () => {
    const input = fakeInput(true);
    const result = readSecret("", input, () => undefined);
    input.emit("error", new Error("EIO"));
    await expect(result).rejects.toBeInstanceOf(TerminalReadError);
    expect(input.raw.at(-1)).toBe(false);
  });

  it("accepts end of input on a terminal", async () => {
    const input = fakeInput(true);
    const result = readSecret("", input, () => undefined);
    input.emit("data", "typed-key");
    input.emit("end");
    expect(await result).toBe("typed-key");
  });

  it("refuses, without prompting, when the terminal will not enter raw mode", async () => {
    const input = Object.assign(fakeInput(true), {
      setRawMode: () => {
        throw new Error("EINVAL");
      },
    });
    const out: string[] = [];
    await expect(readSecret("Key: ", input, (t) => out.push(t))).rejects.toBeInstanceOf(
      InputNotHiddenError,
    );
    expect(out).toEqual([]);
    expect(input.resume).not.toHaveBeenCalled();
  });

  it.each([
    ["not a terminal", { isTTY: false }],
    ["isTTY undefined (e.g. mintty without winpty)", { isTTY: undefined }],
    ["a terminal without raw mode", { setRawMode: undefined }],
  ])("refuses before prompting or reading when input is %s", async (_case, override) => {
    const input = Object.assign(fakeInput(true), override);
    const out: string[] = [];
    await expect(readSecret("Key: ", input, (t) => out.push(t))).rejects.toBeInstanceOf(
      InputNotHiddenError,
    );
    expect(out).toEqual([]);
    expect(input.resume).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
  });
});

describe("readPiped", () => {
  it("reads piped input", async () => {
    const input = fakeInput(false);
    const result = readPiped(input);
    input.emit("data", "piped-key");
    input.emit("end");
    expect(await result).toBe("piped-key");
  });

  it("refuses an interactive terminal, where typing would be shown", async () => {
    const input = fakeInput(true);
    await expect(readPiped(input)).rejects.toBeInstanceOf(InputNotHiddenError);
    expect(input.resume).not.toHaveBeenCalled();
  });
});

describe("readPiped (all of standard input)", () => {
  it("collects all input", async () => {
    const input = fakeInput(false);
    const result = readPiped(input);
    input.emit("data", "a");
    input.emit("data", "b");
    input.emit("end");
    expect(await result).toBe("ab");
  });

  it("rejects on a stream error", async () => {
    const input = fakeInput(false);
    const result = readPiped(input);
    input.emit("error", new Error("broken pipe"));
    await expect(result).rejects.toThrow("broken pipe");
    const other = readPiped(input);
    input.emit("error", "odd");
    await expect(other).rejects.toThrow("odd");
  });
});
