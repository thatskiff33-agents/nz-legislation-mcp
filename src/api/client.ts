/**
 * Hardened client for the NZ Legislation API (v0).
 *
 * Security properties:
 *  - The API key is only ever sent as the `X-Api-Key` header, only to API_ORIGIN, and is
 *    never placed in a URL. Redirects are refused, so the key cannot follow one elsewhere.
 *  - Identifiers are re-validated by the domain parser before being placed in a URL path.
 *  - Response bodies are size-capped while streaming, then schema-parsed.
 *
 * Resilience: per-attempt timeout, bounded retries with full-jitter backoff on 502/503/504 and
 * network failures only, a circuit breaker, distinct errors per failure, and coalescing of
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

/** Last rate-limit figures seen from the API. */
export interface QuotaSnapshot {
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds (UTC) when the daily quota resets. */
  readonly resetEpochSeconds: number;
  /** When these figures were observed (ms since epoch). */
  readonly observedAt: number;
}

export interface ClientOptions {
  readonly apiKey: Secret;
  readonly timeoutMs: number;
  readonly cache?: ResponseCache | undefined;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /** Retries after the first attempt for retryable failures. */
  readonly maxRetries?: number;
  readonly maxBodyBytes?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
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

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class LegislationClient {
  readonly #apiKey: Secret;
  readonly #timeoutMs: number;
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

  #consecutiveFailures = 0;
  #circuitOpenUntil = 0;
  #quota: QuotaSnapshot | undefined;

  constructor(options: ClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
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

  /** Most recent rate-limit headers, or undefined if no successful call has been made yet. */
  get quota(): QuotaSnapshot | undefined {
    return this.#quota;
  }

  /** Search works (GET /v0/works/). */
  searchWorks(params: SearchParams): Promise<SearchResponse> {
    const query = toSearchQuery(params);
    query.sort();
    return this.#get("/v0/works/", query, SearchResponseSchema, CACHE_TTL_MS.search, "Search");
  }

  /** List versions of a work (GET /v0/works/{work_id}/versions/). */
  listVersions(params: VersionListParams): Promise<VersionListResponse> {
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
    );
  }

  /** Get one version (GET /v0/versions/{version_id}/). */
  getVersion(versionId: string): Promise<VersionRecord> {
    const version = parseVersionId(versionId);
    if (!version.ok) throw new TypeError(version.error); // unreachable after schema validation
    return this.#get(
      `/v0/versions/${encodeURIComponent(versionId)}/`,
      new URLSearchParams(),
      VersionRecordSchema,
      CACHE_TTL_MS.version,
      `Version ${versionId}`,
    );
  }

  // -------------------------------------------------------------------------

  #get<T>(
    path: string,
    query: URLSearchParams,
    schema: z.ZodType<T>,
    ttlMs: number,
    what: string,
  ): Promise<T> {
    const url = buildApiUrl(path, query);
    const key = url.toString();

    const cached = this.#cache?.get(key);
    if (cached !== undefined) return Promise.resolve(cached as T);

    return this.#coalescer.run(key, async () => {
      const value = await this.#fetchWithRetry(url, schema, what);
      this.#cache?.set(key, value, ttlMs);
      return value;
    });
  }

  async #fetchWithRetry<T>(url: URL, schema: z.ZodType<T>, what: string): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      this.#checkCircuit();
      try {
        const value = await this.#attempt(url, schema, what);
        this.#consecutiveFailures = 0;
        return value;
      } catch (error) {
        const apiError = error instanceof ApiError ? error : apiErrors.network();
        if (isUpstreamFault(apiError)) this.#recordFailure();
        const canRetry =
          attempt < this.#maxRetries &&
          (apiError.kind === "upstream_unavailable" || apiError.kind === "network");
        this.#logger.warn("api request failed", {
          path: url.pathname,
          kind: apiError.kind,
          status: apiError.status,
          attempt: attempt + 1,
          willRetry: canRetry,
        });
        if (!canRetry) throw apiError;
        await this.#sleep(this.#backoff(attempt));
      }
    }
  }

  async #attempt<T>(url: URL, schema: z.ZodType<T>, what: string): Promise<T> {
    const started = this.#now();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": this.#apiKey.reveal(),
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw apiErrors.timeout(this.#timeoutMs);
      }
      throw apiErrors.network();
    }

    this.#captureQuota(response.headers);
    this.#logger.debug("api response", {
      path: url.pathname,
      status: response.status,
      ms: this.#now() - started,
    });

    if (response.status !== 200) {
      await response.body?.cancel();
      throw this.#statusError(response, what);
    }

    const text = await this.#readCapped(response);
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
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return apiErrors.dailyQuota(Number.isFinite(reset) && reset > 0 ? reset : undefined);
    }
    if (status === 403) return apiErrors.burstLimit();
    if (RETRYABLE_STATUSES.has(status)) return apiErrors.upstreamUnavailable(status);
    return apiErrors.upstreamError(status);
  }

  /** Reads the body as text, aborting as soon as it exceeds the byte limit. */
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
    return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
  }

  #captureQuota(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (
      headers.has("x-ratelimit-remaining") &&
      [limit, remaining, reset].every((n) => Number.isInteger(n) && n >= 0)
    ) {
      this.#quota = {
        limit,
        remaining,
        resetEpochSeconds: reset,
        observedAt: this.#now(),
      };
    }
  }

  #checkCircuit(): void {
    const remainingMs = this.#circuitOpenUntil - this.#now();
    if (remainingMs > 0) throw apiErrors.circuitOpen(remainingMs);
  }

  #recordFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#circuitThreshold) {
      this.#circuitOpenUntil = this.#now() + this.#circuitCooldownMs;
      this.#consecutiveFailures = 0;
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
 * Builds an API URL and refuses anything that would leave API_ORIGIN (for example a
 * protocol-relative "//host" path). Defence in depth: callers already pass validated paths.
 */
export function buildApiUrl(path: string, query: URLSearchParams): URL {
  const url = new URL(path, API_ORIGIN);
  url.search = query.toString();
  if (url.origin !== API_ORIGIN || !path.startsWith("/v0/")) {
    throw new TypeError("Refusing to build a request URL outside the Legislation API.");
  }
  return url;
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
