/**
 * Minimal structured logger.
 *
 * Writes one JSON object per line to stderr (stdout is reserved for the MCP stdio protocol).
 * Redaction is mandatory: string values are redacted before serialisation (so escaping cannot
 * hide a secret) and the finished line is redacted again. Serialisation never throws.
 */
import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Removes secrets from text, e.g. `secret.redact`. Required so it cannot be forgotten. */
  readonly redact: (text: string) => string;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

/** JSON.stringify that redacts strings, tolerates BigInt/Error/cycles, and never throws. */
function serialise(record: Record<string, unknown>, redact: (text: string) => string): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(record, (_key, value: unknown) => {
      if (typeof value === "string") return redact(value);
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error) return { name: value.name, message: redact(value.message) };
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({
      time: record["time"],
      level: record["level"],
      message: record["message"],
      fields: "[unserialisable]",
    });
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const { redact } = options;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const log =
    (level: LogLevel) =>
    (message: string, fields: Fields = {}): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      // Reserved keys last, so a field can never spoof time, level or message.
      const record = { ...fields, time: now().toISOString(), level, message };
      write(`${redact(serialise(record, redact))}\n`);
    };

  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** A logger that discards everything (tests, or callers that do not log). */
export const silentLogger: Logger = createLogger({
  level: "error",
  redact: (text) => text,
  write: () => undefined,
});
