/**
 * Per-key token-bucket rate limiter (in memory, bounded). Protects the operator's API quota and
 * the upstream API from a misbehaving client.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Most distinct keys tracked; the oldest are dropped first. */
const MAX_KEYS = 10_000;

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #perMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#perMs = perMinute / 60_000;
  }

  /** Takes one token for `key`; returns false if the key is over its limit. */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.perMinute, updatedAt: now };
    bucket.tokens = Math.min(
      this.perMinute,
      bucket.tokens + (now - bucket.updatedAt) * this.#perMs,
    );
    bucket.updatedAt = now;
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    for (const oldest of this.#buckets.keys()) {
      if (this.#buckets.size <= MAX_KEYS) break;
      this.#buckets.delete(oldest);
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
