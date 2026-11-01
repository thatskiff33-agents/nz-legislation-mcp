/**
 * Runtime configuration, parsed once from environment variables at start-up.
 *
 * Error messages name the variable at fault but never echo its value.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Secret } from "./secret.js";

export const ENV = {
  apiKey: "LEGISLATION_NZ_API_KEY",
  apiKeyFile: "LEGISLATION_NZ_API_KEY_FILE",
  timeoutMs: "LEGISLATION_NZ_TIMEOUT_MS",
  cache: "LEGISLATION_NZ_CACHE",
  logLevel: "LEGISLATION_NZ_LOG_LEVEL",
} as const;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Response caching modes. `off` until PCO confirms caching is allowed (issue #3). */
export const CACHE_MODES = ["off", "memory"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

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
  "your_api_key",
  "changeme",
  "xxx",
]);

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;
/** Printable ASCII with no spaces: rules out pasted whitespace, quotes and control characters. */
const KEY_CHARSET = /^[\x21-\x7e]+$/;

function validateKey(raw: string, source: string): string | Error {
  const key = raw.trim();
  if (key.length === 0) return new Error(`${source} is empty.`);
  if (PLACEHOLDER_KEYS.has(key.toLowerCase())) {
    return new Error(
      `${source} still contains the placeholder text. Replace it with your API key.`,
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

const defaultReader: FileReader = (path) => readFileSync(path, "utf8");

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
    } catch {
      problems.push(`${ENV.apiKeyFile} points to a file that cannot be read.`);
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
