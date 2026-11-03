/** Terminal input helpers for `setup` (hidden key entry, reading standard input). */

/** The parts of a readable stream these helpers use (process.stdin in production). */
export interface Input {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  on: (event: "data" | "end" | "error", listener: (chunk?: unknown) => void) => unknown;
  removeAllListeners: (event?: string) => unknown;
  resume: () => unknown;
  pause: () => unknown;
}

/** Key entry was cancelled (Ctrl-C) or the terminal could not be read. */
export class InputCancelledError extends Error {
  override readonly name = "InputCancelledError";
}

/**
 * Prompts and reads one line. On a terminal the typed characters are not echoed (the key is
 * never shown on screen); Ctrl-C cancels. Without a terminal, the first line is read as-is.
 */
export function readSecret(
  prompt: string,
  input: Input,
  output: (text: string) => void,
): Promise<string> {
  output(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const raw = input.isTTY === true && typeof input.setRawMode === "function";
    const finish = (error?: Error): void => {
      if (raw) input.setRawMode?.(false);
      input.removeAllListeners("data");
      input.removeAllListeners("end");
      input.removeAllListeners("error");
      input.pause();
      output("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    if (raw) input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003") {
          finish(new InputCancelledError("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    });
    input.on("end", () => {
      finish();
    });
    input.on("error", () => {
      finish(new InputCancelledError("Could not read from the terminal."));
    });
    input.resume();
  }).then(stripPasteMarkers);
}

/** Removes bracketed-paste markers (ESC [200~ and ESC [201~) that some terminals wrap pastes in. */
function stripPasteMarkers(value: string): string {
  return value.replaceAll(/\[20[01]~/gu, "");
}

/** Reads all of standard input as text. */
export function readAll(input: Input): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      text += String(chunk);
    });
    input.on("end", () => {
      resolve(text);
    });
    input.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    input.resume();
  });
}
