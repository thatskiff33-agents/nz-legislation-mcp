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
  readonly weight: number;
}

/** An optional size budget: entries are weighed (for example in characters) and the total capped. */
export interface CacheBudget {
  readonly maxWeight: number;
  readonly weigh: (value: unknown) => number;
}

/**
 * Bounded LRU: a Map keeps insertion order, so re-inserting on read marks an entry as recent.
 * Bounded by entry count and, with a budget, by total weight; a value heavier than the whole
 * budget is not stored.
 */
export class MemoryCache implements ResponseCache {
  readonly #entries = new Map<string, Entry>();
  #weight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
    private readonly budget?: CacheBudget,
  ) {}

  get(key: string): unknown {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#remove(key, entry);
    if (entry.expiresAt <= this.now()) return undefined;
    this.#add(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    // Weigh first: a weight that is not a finite, non-negative number would corrupt the running
    // total, so it is refused before anything changes (the key keeps any value it had).
    const weight = this.budget?.weigh(value) ?? 0;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        `Cache weight must be a finite, non-negative number, got ${String(weight)}.`,
      );
    }
    const previous = this.#entries.get(key);
    if (previous !== undefined) this.#remove(key, previous);
    if (this.budget !== undefined && weight > this.budget.maxWeight) return;
    this.#add(key, { value, expiresAt: this.now() + ttlMs, weight });
    const maxWeight = this.budget?.maxWeight ?? Infinity;
    // Over a limit: drop expired entries first, so they never push out live ones.
    const time = this.now();
    if (this.#entries.size > this.maxEntries || this.#weight > maxWeight) {
      for (const [staleKey, stale] of this.#entries) {
        if (stale.expiresAt <= time) this.#remove(staleKey, stale);
      }
    }
    // Then evict least recently used entries (Map iterates oldest first; deleting while iterating is safe).
    for (const [oldest, entry] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && this.#weight <= maxWeight) break;
      this.#remove(oldest, entry);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Total weight held (0 without a budget). */
  get weight(): number {
    return this.#weight;
  }

  #add(key: string, entry: Entry): void {
    this.#entries.set(key, entry);
    this.#weight += entry.weight;
  }

  #remove(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#weight -= entry.weight;
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
