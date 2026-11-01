/**
 * Runtime configuration, parsed once from environment variables at start-up.
 *
 * Error messages name the variable at fault but never echo its value.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { Secret } from "./secret.js";

export const ENV = {
  apiKey: "LEGISLATION_NZ_API_KEY",
  apiKeyFile: "LEGISLATION_NZ_API_KEY_FILE",
  timeoutMs: "LEGISLATION_NZ_TIMEOUT_MS",
  cache: "LEGISLATION_NZ_CACHE",
  logLevel: "LEGISLATION_NZ_LOG_LEVEL",
} as const;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** Response caching modes. `off` until PCO confirms caching is allowed (issue #3). */
const CACHE_MODES = ["off", "memory"] as const;
type CacheMode = (typeof CACHE_MODES)[number];

export interface Config {
  readonly apiKey: Secret;
  readonly timeoutMs: number;
  readonly cache: CacheMode;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Placeholder values people paste from setup instructions by mistake. */
const PLACEHOLDER_KEYS = new Set([
  "your_key",
  "your-key",
  "your-key-here",
  "your_key_here",
  "your_api_key",
  "your-api-key",
  "your_api_key_here",
  "your-api-key-here",
  "changeme",
  "xxx",
]);
/** Unexpanded variables (`${VAR}`, `$VAR`, `%VAR%`) and template markers (`<your key>`). */
const PLACEHOLDER_PATTERN =
  /^\$\{.*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^%[A-Za-z_][A-Za-z0-9_]*%$|^<.*>$/;

/** Upper bound for a key file; anything larger is not a key. */
const MAX_KEY_FILE_BYTES = 4096;

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;
/** Printable ASCII with no spaces: rules out pasted whitespace, quotes and control characters. */
const KEY_CHARSET = /^[\x21-\x7e]+$/;

function validateKey(raw: string, source: string): string | Error {
  const key = raw.trim();
  if (key.length === 0) return new Error(`${source} is empty.`);
  if (PLACEHOLDER_KEYS.has(key.toLowerCase()) || PLACEHOLDER_PATTERN.test(key)) {
    return new Error(
      `${source} contains placeholder text or an unexpanded variable. Replace it with your API key.`,
    );
  }
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return new Error(
      `${source} must be ${String(MIN_KEY_LENGTH)} to ${String(MAX_KEY_LENGTH)} characters.`,
    );
  }
  if (!KEY_CHARSET.test(key) || key.includes('"') || key.includes("'")) {
    return new Error(`${source} contains spaces, quotes or non-printable characters.`);
  }
  return key;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Parses one optional variable; records a problem (without the value) and falls back if invalid. */
function parseOption<T>(
  env: Env,
  name: string,
  schema: z.ZodType<T>,
  fallback: T,
  problems: string[],
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  problems.push(`${name} is invalid: ${result.error.issues.map((i) => i.message).join("; ")}`);
  return fallback;
}

type FileReader = (path: string) => string;

/** A key-file problem whose message is safe to show (it never includes file contents). */
class KeyFileError extends Error {}

/**
 * Reads a key file, refusing anything that is not a small regular file. This prevents, for
 * example, pointing at /dev/stdin (which would swallow MCP stdio traffic) or a huge file.
 */
const defaultReader: FileReader = (path) => {
  // Open once and check/read through the same descriptor (no check-then-use race). O_NONBLOCK
  // stops a FIFO from blocking the open; the regular-file check then rejects it.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new KeyFileError("cannot be read");
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new KeyFileError("is not a regular file");
    // Read at most one byte more than the limit, so oversized files are detected without
    // trusting the size reported by stat.
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_KEY_FILE_BYTES) {
        throw new KeyFileError(`is larger than ${String(MAX_KEY_FILE_BYTES)} bytes`);
      }
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
};

/**
 * Loads configuration from the environment.
 *
 * The key comes from `LEGISLATION_NZ_API_KEY`, or from a file named by
 * `LEGISLATION_NZ_API_KEY_FILE` (Docker/Kubernetes secrets pattern). Setting both is an error.
 */
export function loadConfig(env: Env = process.env, readFile: FileReader = defaultReader): Config {
  const problems: string[] = [];
  const direct = env[ENV.apiKey];
  const file = env[ENV.apiKeyFile];

  let key: string | undefined;
  if (direct !== undefined && direct !== "" && file !== undefined && file !== "") {
    problems.push(`Set only one of ${ENV.apiKey} or ${ENV.apiKeyFile}, not both.`);
  } else if (file !== undefined && file !== "") {
    let contents: string | undefined;
    try {
      contents = readFile(file);
    } catch (error) {
      const reason = error instanceof KeyFileError ? error.message : "cannot be read";
      problems.push(`${ENV.apiKeyFile} points to a file that ${reason}.`);
    }
    if (contents !== undefined) {
      const result = validateKey(contents, `The file named by ${ENV.apiKeyFile}`);
      if (result instanceof Error) problems.push(result.message);
      else key = result;
    }
  } else if (direct !== undefined && direct !== "") {
    const result = validateKey(direct, ENV.apiKey);
    if (result instanceof Error) problems.push(result.message);
    else key = result;
  } else {
    problems.push(
      `No API key found. Set ${ENV.apiKey} to your NZ Legislation API key (request one from contact@pco.govt.nz).`,
    );
  }

  const timeoutMs = parseOption(
    env,
    ENV.timeoutMs,
    z.coerce.number().int().min(1_000).max(120_000),
    15_000,
    problems,
  );
  const cache = parseOption(env, ENV.cache, z.enum(CACHE_MODES), "off", problems);
  const logLevel = parseOption(env, ENV.logLevel, z.enum(LOG_LEVELS), "info", problems);

  if (key === undefined || problems.length > 0) throw new ConfigError(problems);
  return { apiKey: new Secret(key), timeoutMs, cache, logLevel };
}
