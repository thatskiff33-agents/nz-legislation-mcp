/**
 * Minimal structured logger.
 *
 * Writes one JSON object per line to stderr (stdout is reserved for the MCP stdio protocol).
 * Every line passes through a redactor so a secret can never be logged by accident.
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
  /** Applied to each serialised line before it is written (e.g. `secret.redact`). */
  readonly redact?: (line: string) => string;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const redact = options.redact ?? ((line: string) => line);
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const log =
    (level: LogLevel) =>
    (message: string, fields: Fields = {}): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      const line = JSON.stringify({ time: now().toISOString(), level, message, ...fields });
      write(`${redact(line)}\n`);
    };

  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** A logger that discards everything (tests, or callers that do not log). */
export const silentLogger: Logger = createLogger({ level: "error", write: () => undefined });
