/**
 * `nz-legislation-mcp setup`: stores the user's API key in a private file so client configs
 * never need the key inline. The key is checked (format, then one API call) before it is saved.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LegislationClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { defaultKeyFilePath, validateKey } from "../config.js";
import { Secret } from "../secret.js";
import { InputCancelledError, InputNotHiddenError, TerminalReadError } from "./terminal.js";
import { CLIENT_SETUP_HINT } from "./clients.js";
import { terminalMessage } from "./messages.js";

export interface SetupIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /**
   * Prompts and reads one line without echoing it. Rejects with InputNotHiddenError when the
   * terminal cannot hide input, and InputCancelledError on Ctrl-C.
   */
  readonly readSecret: (prompt: string) => Promise<string>;
  /** Reads all of standard input (for --key-stdin). */
  readonly readStdin: () => Promise<string>;
  /** Checks a key against the API: resolves on success, rejects with ApiError otherwise. */
  readonly verify: (key: string) => Promise<void>;
  readonly keyFilePath?: string | undefined;
  /** Defaults to process.platform (overridable for tests). */
  readonly platform?: NodeJS.Platform | undefined;
}

const USAGE = `Usage: nz-legislation-mcp setup [--key-stdin] [--no-verify] [--force]

Stores your Legislation API key in a private file (<config dir>/nz-legislation-mcp/key, mode 600)
so AI clients can run the server without the key in their settings.

  --key-stdin   Read the key from standard input instead of prompting.
  --no-verify   Do not check the key with the API before saving it.
  --force       Replace an existing key file.
`;

/** Default key check: one small search request (counts as one request against the quota). */
export async function verifyWithApi(key: string): Promise<void> {
  const client = new LegislationClient({ apiKey: new Secret(key), timeoutMs: 15_000 });
  await client.searchWorks({ search_term: "Interpretation", search_field: "title", per_page: 1 });
}

/** Writes a file readable only by the owner, atomically (temporary file, then rename). */
function writePrivate(path: string, contents: string, platform: NodeJS.Platform): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Tighten a folder that already existed (mkdir's mode only applies when it creates one).
  if (platform !== "win32") chmodSync(directory, 0o700);
  const temporary = join(directory, `.key-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, contents);
      fsyncSync(fd); // the key is on disk before the rename makes it visible
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function runSetup(argv: readonly string[], io: SetupIo): Promise<number> {
  const flags = new Set(argv);
  const known = new Set(["--key-stdin", "--no-verify", "--force"]);
  if ([...flags].some((flag) => !known.has(flag))) {
    io.stderr(USAGE);
    return 2;
  }
  const path = io.keyFilePath ?? defaultKeyFilePath(io.env);
  if (existsSync(path) && !flags.has("--force")) {
    io.stderr(`A key is already saved at ${path}. Use --force to replace it.\n`);
    return 1;
  }

  let raw: string;
  try {
    raw = flags.has("--key-stdin")
      ? await io.readStdin()
      : await io.readSecret("Paste your NZ Legislation API key (input hidden): ");
  } catch (error) {
    if (error instanceof InputNotHiddenError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    const message =
      error instanceof InputCancelledError || error instanceof TerminalReadError
        ? error.message
        : "Could not read the key.";
    io.stderr(`${message} Nothing was saved.\n`);
    // 130 is the shell convention for Ctrl-C; any other read problem is an ordinary failure.
    return error instanceof InputCancelledError ? 130 : 1;
  }
  const key = validateKey(raw, "The key");
  if (key instanceof Error) {
    io.stderr(`${key.message}\n`);
    return 1;
  }

  if (!flags.has("--no-verify")) {
    try {
      await io.verify(key);
      io.stdout("Key checked with the Legislation API: OK.\n");
    } catch (error) {
      const message =
        error instanceof ApiError
          ? terminalMessage(error, "setup")
          : "The key could not be checked.";
      io.stderr(`${message}\nNothing was saved. Use --no-verify to save it anyway.\n`);
      return 1;
    }
  }

  const platform = io.platform ?? process.platform;
  writePrivate(path, `${key}\n`, platform);
  const privacy =
    platform === "win32"
      ? "in your user profile, protected by your Windows account's file permissions"
      : "readable only by you";
  io.stdout(`Saved your key to ${path} (${privacy}).\n\n${CLIENT_SETUP_HINT}`);
  return 0;
}
