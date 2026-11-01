/**
 * In-memory response cache (LRU with per-entry TTL) and in-flight request coalescing.
 *
 * Caching is OFF by default until the PCO confirms in writing that it is allowed (issue #3).
 * Coalescing is always on: it shares one in-flight request between identical concurrent calls
 * and stores nothing once the request settles.
 */

export interface ResponseCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs: number): void;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** Bounded LRU: a Map keeps insertion order, so re-inserting on read marks an entry as recent. */
export class MemoryCache implements ResponseCache {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): unknown {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs });
    // Evict least recently used entries (Map iterates oldest first; deleting while iterating is safe).
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.maxEntries) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Shares a single in-flight promise per key between concurrent callers. */
export class Coalescer {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = task().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.#inFlight.size;
  }
}
