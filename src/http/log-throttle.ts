/**
 * Throttled warn logging for refusals: at most one record per key per interval, so a flood of
 * bad requests cannot flood the log. The next record for a key carries `suppressedSinceLast`,
 * the number of records not written in between. Keys must come from a fixed set (refusal
 * reasons, jose error codes) so the map stays small.
 */
import type { Logger } from "../logger.js";

/** At most one log record per key in this period. */
const LOG_THROTTLE_INTERVAL_MS = 60_000;

export function throttledWarn(
  logger: Logger,
  message: string,
  now: () => number = Date.now,
): (key: string, fields: Readonly<Record<string, unknown>>) => void {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (key, fields) => {
    const time = now();
    const entry = last.get(key);
    if (entry !== undefined && time - entry.at < LOG_THROTTLE_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    last.set(key, { at: time, suppressed: 0 });
    logger.warn(message, {
      ...fields,
      ...(entry === undefined || entry.suppressed === 0
        ? {}
        : { suppressedSinceLast: entry.suppressed }),
    });
  };
}
