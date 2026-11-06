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

/** Key entry was cancelled with Ctrl-C. */
export class InputCancelledError extends Error {
  override readonly name = "InputCancelledError";
}

/** Standard input is not a terminal that can hide typing, so the key would be shown. */
export class InputNotHiddenError extends Error {
  override readonly name = "InputNotHiddenError";
}

/** The terminal could not be read. */
export class TerminalReadError extends Error {
  override readonly name = "TerminalReadError";
}

/**
 * Prompts and reads one line with the typed characters hidden (raw mode); Ctrl-C cancels.
 * Refuses, before prompting, when the input is not a terminal that supports raw mode (for
 * example Git Bash or mintty without winpty), because typing there would be shown on screen.
 */
export function readSecret(
  prompt: string,
  input: Input,
  output: (text: string) => void,
): Promise<string> {
  const notHidden = new InputNotHiddenError(
    "This terminal can't hide your key. Run setup in PowerShell or Windows Terminal, or pipe the key in with --key-stdin.",
  );
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    return Promise.reject(notHidden);
  }
  // Hide typing before the prompt invites it; a terminal that refuses raw mode is refused too.
  try {
    input.setRawMode(true);
  } catch {
    return Promise.reject(notHidden);
  }
  output(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.setRawMode?.(false);
      input.removeAllListeners("data");
      input.removeAllListeners("end");
      input.removeAllListeners("error");
      input.pause();
      output("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
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
      finish(new TerminalReadError("Could not read from the terminal."));
    });
    input.resume();
  }).then(stripPasteMarkers);
}

/** Removes bracketed-paste markers (ESC [200~ and ESC [201~) that some terminals wrap pastes in. */
function stripPasteMarkers(value: string): string {
  return value.replaceAll(/\[20[01]~/gu, "");
}

/**
 * Reads piped standard input for `setup --key-stdin`. Refuses when standard input is an
 * interactive terminal, where the key would be shown as it is typed. (mintty without winpty
 * looks like a pipe and cannot be detected; see the threat model.)
 */
export function readPiped(input: Input): Promise<string> {
  if (input.isTTY === true) {
    return Promise.reject(
      new InputNotHiddenError(
        "--key-stdin is for piped input, for example: nz-legislation-mcp setup --key-stdin < keyfile. To type your key, run setup without --key-stdin and it will be hidden.",
      ),
    );
  }
  return readAll(input);
}

/** Reads all of standard input as text. */
function readAll(input: Input): Promise<string> {
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
