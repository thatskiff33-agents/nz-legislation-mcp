/**
 * Hardened client for the NZ Legislation API (v0).
 *
 * Security properties:
 *  - The API key is only ever sent as the `X-Api-Key` header, only to API_ORIGIN, and is
 *    never placed in a URL. Redirects are not followed, so the key cannot follow one elsewhere.
 *  - Identifiers are re-validated by the domain parser before being placed in a URL path, and
 *    the resolved URL must stay under API_ORIGIN/v0/.
 *  - Response bodies are size-capped while streaming (after decompression), then schema-parsed.
 *    Parsed results are deep-frozen, so callers sharing a coalesced or cached result cannot
 *    affect each other.
 *
 * Resilience: per-attempt timeout inside an overall time budget, bounded retries with
 * full-jitter backoff on 502/503/504 and network failures only, a circuit breaker with a
 * single half-open probe, caller cancellation, distinct errors per failure, and coalescing of
 * identical concurrent requests.
 */
import type { z } from "zod";
import { parseVersionId, parseWorkId } from "../domain/ids.js";
import {
  SearchResponseSchema,
  toSearchQuery,
  VersionListResponseSchema,
  VersionRecordSchema,
  type SearchParams,
  type VersionListParams,
} from "../domain/schemas.js";
import { API_ORIGIN } from "../domain/vocabulary.js";
import { silentLogger, type Logger } from "../logger.js";
import type { Secret } from "../secret.js";
import { USER_AGENT } from "../version.js";
import { Coalescer, type ResponseCache } from "./cache.js";
import { ApiError, apiErrors } from "./errors.js";

export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;
export type VersionRecord = z.infer<typeof VersionRecordSchema>;

/** Last rate-limit figures seen from the API (from any response that carried them). */
export interface QuotaSnapshot {
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds (UTC) when the daily quota resets. */
  readonly resetEpochSeconds: number;
  /** When these figures were observed (ms since epoch). */
  readonly observedAt: number;
}

/** Per-call options. */
export interface CallOptions {
  /** Aborts this caller's wait (e.g. MCP request cancellation). */
  readonly signal?: AbortSignal | undefined;
}

export interface ClientOptions {
  readonly apiKey: Secret;
  /** Timeout for a single attempt. */
  readonly timeoutMs: number;
  /** Overall budget for one call, including retries and backoff. Default 25 s. */
  readonly totalBudgetMs?: number;
  readonly cache?: ResponseCache | undefined;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /** Retries after the first attempt for retryable failures. */
  readonly maxRetries?: number;
  readonly maxBodyBytes?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** Consecutive upstream-fault attempts that open the circuit. */
  readonly circuitThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Cache lifetimes (only used when the optional cache is enabled). */
export const CACHE_TTL_MS = {
  search: 10 * 60 * 1000,
  versions: 60 * 60 * 1000,
  version: 60 * 60 * 1000,
} as const;

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Do not start a retry unless at least this much of the budget remains. */
const MIN_ATTEMPT_MS = 1000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class LegislationClient {
  readonly #apiKey: Secret;
  readonly #timeoutMs: number;
  readonly #totalBudgetMs: number;
  readonly #cache: ResponseCache | undefined;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #maxBodyBytes: number;
  readonly #backoffBaseMs: number;
  readonly #backoffCapMs: number;
  readonly #circuitThreshold: number;
  readonly #circuitCooldownMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #coalescer = new Coalescer();

  #consecutiveFaults = 0;
  /** 0 when closed; otherwise when the open period ends (then half-open). */
  #circuitOpenUntil = 0;
  #probeInFlight = false;
  #quota: QuotaSnapshot | undefined;

  constructor(options: ClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#totalBudgetMs = options.totalBudgetMs ?? 25_000;
    this.#cache = options.cache;
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#backoffBaseMs = options.backoffBaseMs ?? 250;
    this.#backoffCapMs = options.backoffCapMs ?? 4000;
    this.#circuitThreshold = options.circuitThreshold ?? 5;
    this.#circuitCooldownMs = options.circuitCooldownMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** Most recent rate-limit figures, or undefined if no response has carried them yet. */
  get quota(): QuotaSnapshot | undefined {
    return this.#quota;
  }

  /** Search works (GET /v0/works/). */
  async searchWorks(params: SearchParams, options: CallOptions = {}): Promise<SearchResponse> {
    const query = toSearchQuery(params);
    query.sort();
    return this.#get(
      "/v0/works/",
      query,
      SearchResponseSchema,
      CACHE_TTL_MS.search,
      "Search",
      options,
    );
  }

  /** List versions of a work (GET /v0/works/{work_id}/versions/). */
  async listVersions(
    params: VersionListParams,
    options: CallOptions = {},
  ): Promise<VersionListResponse> {
    const work = parseWorkId(params.work_id);
    if (!work.ok) throw new TypeError(work.error); // unreachable after schema validation
    const query = new URLSearchParams();
    if (params.sort !== undefined) query.set("sort", params.sort);
    if (params.page !== undefined) query.set("page", String(params.page));
    if (params.per_page !== undefined) query.set("per_page", String(params.per_page));
    query.sort();
    return this.#get(
      `/v0/works/${encodeURIComponent(params.work_id)}/versions/`,
      query,
      VersionListResponseSchema,
      CACHE_TTL_MS.versions,
      `Work ${params.work_id}`,
      options,
    );
  }

  /** Get one version (GET /v0/versions/{version_id}/). */
  async getVersion(versionId: string, options: CallOptions = {}): Promise<VersionRecord> {
    const version = parseVersionId(versionId);
    if (!version.ok) throw new TypeError(version.error); // unreachable after schema validation
    return this.#get(
      `/v0/versions/${encodeURIComponent(versionId)}/`,
      new URLSearchParams(),
      VersionRecordSchema,
      CACHE_TTL_MS.version,
      `Version ${versionId}`,
      options,
    );
  }

  // -------------------------------------------------------------------------

  async #get<T>(
    path: string,
    query: URLSearchParams,
    schema: z.ZodType<T>,
    ttlMs: number,
    what: string,
    { signal }: CallOptions,
  ): Promise<T> {
    if (signal?.aborted === true) throw apiErrors.cancelled();
    const url = buildApiUrl(path, query);
    const key = url.toString();

    const cached = this.#cache?.get(key);
    if (cached !== undefined) return cached as T;

    // The shared request is bounded by the client's own budget; a caller's signal only
    // detaches that caller, so cancelling one caller never fails the others.
    const shared = this.#coalescer.run(key, async () => {
      const value = deepFreeze(await this.#fetchWithRetry(url, schema, what));
      this.#cache?.set(key, value, ttlMs);
      return value;
    });
    return raceAbort(shared, signal);
  }

  async #fetchWithRetry<T>(url: URL, schema: z.ZodType<T>, what: string): Promise<T> {
    const deadline = this.#now() + this.#totalBudgetMs;
    const budget = AbortSignal.timeout(this.#totalBudgetMs);
    for (let attempt = 0; ; attempt += 1) {
      this.#enterCircuit();
      let apiError: ApiError;
      try {
        const attemptMs = Math.max(1, Math.min(this.#timeoutMs, deadline - this.#now()));
        const value = await this.#attempt(url, schema, what, attemptMs, budget);
        this.#circuitResult(false);
        return value;
      } catch (error) {
        // #attempt converts every failure into an ApiError.
        apiError = error as ApiError;
      }
      this.#circuitResult(isUpstreamFault(apiError));

      const delay = this.#backoff(attempt);
      const retryable = apiError.kind === "upstream_unavailable" || apiError.kind === "network";
      const canRetry =
        retryable && attempt < this.#maxRetries && this.#now() + delay + MIN_ATTEMPT_MS <= deadline;
      this.#logger.warn("api request failed", {
        path: url.pathname,
        kind: apiError.kind,
        status: apiError.status,
        attempt: attempt + 1,
        willRetry: canRetry,
      });
      if (!canRetry) throw apiError;
      await this.#sleep(delay);
    }
  }

  async #attempt<T>(
    url: URL,
    schema: z.ZodType<T>,
    what: string,
    attemptMs: number,
    budget: AbortSignal,
  ): Promise<T> {
    const started = this.#now();
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": this.#apiKey.reveal(),
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        // Never follow redirects: surface them as errors instead.
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(attemptMs), budget]),
      });

      this.#captureQuota(response);
      this.#logger.debug("api response", {
        path: url.pathname,
        status: response.status,
        ms: this.#now() - started,
      });

      if (response.status !== 200) {
        await response.body?.cancel();
        throw this.#statusError(response, what);
      }

      // The body read is covered by the same signal, so a stalled body times out too.
      const text = await this.#readCapped(response);
      return this.#parse(text, schema, url);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw apiErrors.timeout(attemptMs);
      }
      throw apiErrors.network();
    }
  }

  #parse<T>(text: string, schema: z.ZodType<T>, url: URL): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw apiErrors.invalidResponse();
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      this.#logger.error("api response failed schema validation", {
        path: url.pathname,
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      throw apiErrors.invalidResponse();
    }
    return parsed.data;
  }

  #statusError(response: Response, what: string): ApiError {
    const { status } = response;
    if (status === 401) return apiErrors.unauthorised();
    if (status === 404) return apiErrors.notFound(what);
    if (status === 429) {
      const header = Number(response.headers.get("x-ratelimit-reset"));
      const reset =
        Number.isInteger(header) && header > 0 ? header : this.#quota?.resetEpochSeconds;
      return apiErrors.dailyQuota(reset);
    }
    if (status === 403) return apiErrors.burstLimit();
    if (status >= 300 && status < 400) return apiErrors.unexpectedRedirect(status);
    if (RETRYABLE_STATUSES.has(status)) return apiErrors.upstreamUnavailable(status);
    return apiErrors.upstreamError(status);
  }

  /**
   * Reads the body as text, aborting as soon as it exceeds the byte limit. fetch decompresses
   * transparently, so this counts decompressed bytes (decompression-bomb safe). The
   * content-length check is only an early exit for honest oversized responses.
   */
  async #readCapped(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#maxBodyBytes) {
      await response.body?.cancel();
      throw apiErrors.tooLarge(this.#maxBodyBytes);
    }
    if (response.body === null) return "";
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.#maxBodyBytes) {
        await reader.cancel();
        throw apiErrors.tooLarge(this.#maxBodyBytes);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }

  #captureQuota(response: Response): void {
    const { headers, status } = response;
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    const valid =
      headers.has("x-ratelimit-remaining") &&
      [limit, remaining, reset].every((n) => Number.isInteger(n) && n >= 0);
    const previous = this.#quota;

    if (valid) {
      // Responses can arrive out of order: within one quota period, never raise `remaining`.
      const lower = previous?.resetEpochSeconds === reset && previous.remaining < remaining;
      this.#quota = {
        limit,
        remaining: lower ? previous.remaining : remaining,
        resetEpochSeconds: reset,
        observedAt: this.#now(),
      };
    } else if (status === 429 && previous !== undefined) {
      // A 429 without headers still tells us the quota is exhausted.
      this.#quota = { ...previous, remaining: 0, observedAt: this.#now() };
    }
  }

  /** Throws if the circuit is open; lets exactly one probe through when half-open. */
  #enterCircuit(): void {
    if (this.#circuitOpenUntil === 0) return;
    const remainingMs = this.#circuitOpenUntil - this.#now();
    if (remainingMs > 0) throw apiErrors.circuitOpen(remainingMs);
    if (this.#probeInFlight) throw apiErrors.circuitOpen(1000);
    this.#probeInFlight = true;
  }

  /** Records an attempt's outcome for the circuit breaker. */
  #circuitResult(upstreamFault: boolean): void {
    const wasProbe = this.#probeInFlight;
    this.#probeInFlight = false;
    if (!upstreamFault) {
      this.#consecutiveFaults = 0;
      this.#circuitOpenUntil = 0;
      return;
    }
    this.#consecutiveFaults += 1;
    if (wasProbe || this.#consecutiveFaults >= this.#circuitThreshold) {
      this.#circuitOpenUntil = this.#now() + this.#circuitCooldownMs;
      this.#consecutiveFaults = 0;
      this.#logger.warn("circuit opened", { cooldownMs: this.#circuitCooldownMs });
    }
  }

  /** Full-jitter exponential backoff (AWS architecture blog pattern). */
  #backoff(attempt: number): number {
    const ceiling = Math.min(this.#backoffCapMs, this.#backoffBaseMs * 2 ** attempt);
    return Math.floor(this.#random() * ceiling);
  }
}

/**
 * Builds an API URL and refuses anything that would leave API_ORIGIN/v0/ (for example a
 * protocol-relative "//host" path or a "/v0/../x" traversal). Defence in depth: callers
 * already pass validated, encoded paths.
 */
export function buildApiUrl(path: string, query: URLSearchParams): URL {
  if (/\.\.|%2e|\\/i.test(path)) {
    throw new TypeError("Refusing to build a request URL outside the Legislation API.");
  }
  const url = new URL(path, API_ORIGIN);
  url.search = query.toString();
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith("/v0/")) {
    throw new TypeError("Refusing to build a request URL outside the Legislation API.");
  }
  return url;
}

/** Resolves or rejects with `promise`, unless `signal` aborts first. */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    reject(apiErrors.cancelled());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Recursively freezes plain data so shared results cannot be mutated by one caller. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Failures that say the upstream is unhealthy (as opposed to a bad request or a quota). */
function isUpstreamFault(error: ApiError): boolean {
  return (
    error.kind === "upstream_unavailable" ||
    error.kind === "upstream_error" ||
    error.kind === "network" ||
    error.kind === "timeout"
  );
}
