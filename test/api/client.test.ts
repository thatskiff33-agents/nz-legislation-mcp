import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../../src/api/cache.js";
import {
  buildApiUrl,
  CACHE_TTL_MS,
  LegislationClient,
  type ClientOptions,
} from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import { SearchParamsSchema } from "../../src/domain/schemas.js";
import { createLogger } from "../../src/logger.js";
import { Secret } from "../../src/secret.js";
import { USER_AGENT } from "../../src/version.js";
import { fixture } from "../fixtures.js";
import { fakeFetch, json, RATE_HEADERS, status, type Step } from "./fake-fetch.js";

const KEY = "test-key-0123456789abcdef";
const VERSION_ID = "act_public_2007_97_en_2026-09-04";

function client(steps: Step[], overrides: Partial<ClientOptions> = {}) {
  const fake = fakeFetch(...steps);
  const sleep = vi.fn(() => Promise.resolve());
  let clock = 1_000_000;
  const c = new LegislationClient({
    apiKey: new Secret(KEY),
    timeoutMs: 5000,
    fetch: fake.fn,
    sleep,
    random: () => 0.5,
    now: () => clock,
    ...overrides,
  });
  return {
    c,
    fake,
    sleep,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function expectApiError(promise: Promise<unknown>, kind: string): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe(kind);
  return error as ApiError;
}

const search = SearchParamsSchema.parse({ search_term: "income tax", legislation_type: "act" });

describe("requests", () => {
  it("searches with sorted query, key in header only, no redirects", async () => {
    const { c, fake } = client([json(fixture("search-works"))]);
    const result = await c.searchWorks(search);
    expect(result.total).toBe(241);
    const [call] = fake.calls;
    expect(call?.url).toBe(
      "https://api.legislation.govt.nz/v0/works/?legislation_type=act&search_term=income+tax",
    );
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.headers).toEqual({
      "X-Api-Key": KEY,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists versions with encoded path and options", async () => {
    const { c, fake } = client([json(fixture("work-versions-page1"))]);
    const r = await c.listVersions({
      work_id: "act_public_2007_97",
      sort: "asc",
      page: 2,
      per_page: 100,
    });
    expect(r.total).toBe(206);
    expect(fake.calls[0]?.url).toBe(
      "https://api.legislation.govt.nz/v0/works/act_public_2007_97/versions/?page=2&per_page=100&sort=asc",
    );
  });

  it("lists versions without options", async () => {
    const { c, fake } = client([json(fixture("work-versions-page1"))]);
    await c.listVersions({ work_id: "act_public_2007_97" });
    expect(fake.calls[0]?.url).toBe(
      "https://api.legislation.govt.nz/v0/works/act_public_2007_97/versions/",
    );
  });

  it("gets a version", async () => {
    const { c, fake } = client([json(fixture("version-latest"))]);
    const v = await c.getVersion(VERSION_ID);
    expect(v.title).toBe("Income Tax Act 2007");
    expect(fake.calls[0]?.url).toBe(`https://api.legislation.govt.nz/v0/versions/${VERSION_ID}/`);
  });

  it("refuses identifiers that bypassed schema validation (as a rejected promise)", async () => {
    const { c, fake } = client([]);
    await expect(c.getVersion("../../admin")).rejects.toThrow(TypeError);
    await expect(c.listVersions({ work_id: "act_public_2007_97/../x" })).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("buildApiUrl", () => {
  it("builds API URLs", () => {
    expect(buildApiUrl("/v0/works/", new URLSearchParams("a=1")).toString()).toBe(
      "https://api.legislation.govt.nz/v0/works/?a=1",
    );
  });

  it.each([
    "//evil.example/v0/works/",
    "https://evil.example/v0/",
    "/admin",
    "/v0/../admin",
    "/v0/%2e%2e/%2E%2E/admin",
    "/v0/..\\x",
    "/\\evil.example/v0/",
  ])("refuses %j", (path) => {
    expect(() => buildApiUrl(path, new URLSearchParams())).toThrow(TypeError);
  });
});

describe("status handling", () => {
  it.each([
    [401, "unauthorised", false],
    [404, "not_found", false],
    [403, "burst_limit_exceeded", true],
    [500, "upstream_error", false],
    [418, "upstream_error", false],
  ])("maps %i to %s without retrying", async (code, kind, retryable) => {
    const { c, fake } = client([status(code)]);
    const e = await expectApiError(c.getVersion(VERSION_ID), kind);
    expect(e.retryable).toBe(retryable);
    expect(e.status).toBe(code);
    expect(fake.calls).toHaveLength(1);
    expect(e.message).not.toContain(KEY);
  });

  it.each([301, 302, 307, 308])(
    "surfaces a %i redirect without following or retrying it",
    async (code) => {
      const { c, fake } = client([status(code, { location: "https://evil.example/" })], {
        circuitThreshold: 1,
      });
      const e = await expectApiError(c.getVersion(VERSION_ID), "unexpected_redirect");
      expect(e.retryable).toBe(false);
      expect(fake.calls).toHaveLength(1);
      // Not an upstream fault: the circuit stays closed.
      const again = client([status(code), json(fixture("version-latest"))], {
        circuitThreshold: 1,
      });
      await expectApiError(again.c.getVersion(VERSION_ID), "unexpected_redirect");
      await expect(again.c.getVersion(VERSION_ID)).resolves.toBeTruthy();
    },
  );

  it("names the missing thing on 404", async () => {
    const { c } = client([status(404)]);
    const e = await expectApiError(c.getVersion("act_public_2007_97_en_1900-01-01"), "not_found");
    expect(e.message).toContain("Version act_public_2007_97_en_1900-01-01 was not found");
  });

  it("reports the quota reset time on 429", async () => {
    const { c } = client([status(429, { "x-ratelimit-reset": "1793617200" })]);
    const e = await expectApiError(c.searchWorks(search), "daily_quota_exceeded");
    expect(e.message).toContain(new Date(1793617200 * 1000).toISOString());
  });

  it("uses the last known reset time when 429 has no header", async () => {
    const { c } = client([json(fixture("version-latest")), status(429)]);
    await c.getVersion(VERSION_ID);
    const e = await expectApiError(c.searchWorks(search), "daily_quota_exceeded");
    expect(e.message).toContain(new Date(1793617200 * 1000).toISOString());
    expect(c.quota?.remaining).toBe(0);
  });

  it("falls back to midnight NZ time when 429 has no reset header", async () => {
    const { c } = client([status(429)]);
    const e = await expectApiError(c.searchWorks(search), "daily_quota_exceeded");
    expect(e.message).toContain("midnight New Zealand time");
  });

  it("retries 502/503/504 with full-jitter backoff, then succeeds", async () => {
    const { c, fake, sleep } = client([status(502), status(503), json(fixture("search-works"))]);
    await c.searchWorks(search);
    expect(fake.calls).toHaveLength(3);
    // random()=0.5, base 250: attempt 0 ceiling 250 -> 125; attempt 1 ceiling 500 -> 250
    expect(sleep.mock.calls).toEqual([[125], [250]]);
  });

  it("caps backoff and gives up after maxRetries", async () => {
    const { c, fake, sleep } = client([status(504), status(504), status(504), status(504)], {
      maxRetries: 3,
      backoffBaseMs: 1000,
      backoffCapMs: 1500,
    });
    const e = await expectApiError(c.searchWorks(search), "upstream_unavailable");
    expect(e.retryable).toBe(true);
    expect(fake.calls).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[500], [750], [750]]);
  });

  it("retries network errors", async () => {
    const { c, fake } = client([new TypeError("fetch failed"), json(fixture("search-works"))]);
    await c.searchWorks(search);
    expect(fake.calls).toHaveLength(2);
  });

  it("does not retry timeouts", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const { c, fake } = client([timeout]);
    const e = await expectApiError(c.searchWorks(search), "timeout");
    expect(e.message).toContain("5000 ms");
    expect(fake.calls).toHaveLength(1);
  });

  it("treats other DOMExceptions as network errors", async () => {
    const { c } = client([new DOMException("aborted", "AbortError")], { maxRetries: 0 });
    await expectApiError(c.searchWorks(search), "network");
  });
});

describe("internal errors", () => {
  it("does not retry or trip the circuit for a bug in this server", async () => {
    const logger = {
      debug: () => {
        throw new Error("logger bug");
      },
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const { c, fake } = client([json(fixture("version-latest")), json(fixture("version-latest"))], {
      logger,
      circuitThreshold: 1,
    });
    const e = await expectApiError(c.getVersion(VERSION_ID), "internal_error");
    expect(e.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
    // The circuit stayed closed: the next call is attempted (and fails the same way).
    await expectApiError(c.getVersion(VERSION_ID), "internal_error");
    expect(fake.calls).toHaveLength(2);
  });

  it("tolerates a body that cannot be cancelled on an error status", async () => {
    const stubborn = () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("cannot cancel");
          },
        }),
        { status: 404 },
      );
    const { c } = client([stubborn]);
    await expectApiError(c.getVersion(VERSION_ID), "not_found");
  });
});

describe("time budget", () => {
  it("does not start a retry that would overrun the overall budget", async () => {
    let clock = 0;
    const fake = fakeFetch(status(503), status(503), status(503));
    const c = new LegislationClient({
      apiKey: new Secret(KEY),
      timeoutMs: 5000,
      totalBudgetMs: 3000,
      fetch: fake.fn,
      random: () => 0.99,
      now: () => clock,
      backoffBaseMs: 1500,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    await expectApiError(c.getVersion(VERSION_ID), "upstream_unavailable");
    // attempt 1 at t=0, backoff ~1485 -> attempt 2 at ~1485; next backoff ~2970 would overrun 3000.
    expect(fake.calls).toHaveLength(2);
  });

  it("shrinks the per-attempt timeout to the remaining budget", async () => {
    let clock = 0;
    const timeout = new DOMException("timed out", "TimeoutError");
    const fake = fakeFetch(status(503), timeout);
    const c = new LegislationClient({
      apiKey: new Secret(KEY),
      timeoutMs: 5000,
      totalBudgetMs: 4000,
      fetch: fake.fn,
      random: () => 0.5,
      now: () => clock,
      backoffBaseMs: 2000,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    const e = await expectApiError(c.getVersion(VERSION_ID), "timeout");
    expect(e.message).toContain("3000 ms"); // 4000 budget - 1000 elapsed
  });
});

describe("cancellation", () => {
  it("rejects immediately when already aborted, without a request", async () => {
    const { c, fake } = client([]);
    await expectApiError(c.getVersion(VERSION_ID, { signal: AbortSignal.abort() }), "cancelled");
    expect(fake.calls).toHaveLength(0);
  });

  it("detaches a cancelled caller while other coalesced callers still get the result", async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(() => pending) as unknown as typeof fetch;
    const c = new LegislationClient({ apiKey: new Secret(KEY), timeoutMs: 5000, fetch: fetchFn });
    const controller = new AbortController();
    const cancelled = c.getVersion(VERSION_ID, { signal: controller.signal });
    const other = c.getVersion(VERSION_ID);
    controller.abort();
    await expectApiError(cancelled, "cancelled");
    release(json(fixture("version-latest"))());
    await expect(other).resolves.toMatchObject({ title: "Income Tax Act 2007" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("passes results and errors through when the signal never fires", async () => {
    const { c } = client([json(fixture("version-latest")), status(404)]);
    const signal = new AbortController().signal;
    await expect(c.getVersion(VERSION_ID, { signal })).resolves.toBeTruthy();
    await expectApiError(c.getVersion("act_public_2007_97_en_1900-01-01", { signal }), "not_found");
  });
});

describe("response handling", () => {
  it("returns deeply frozen results so callers cannot mutate shared data", async () => {
    const { c } = client([json(fixture("search-works"))]);
    const r = await c.searchWorks(search);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.results[0]?.latest_matching_version.formats)).toBe(true);
    expect(() => {
      (r as { total: number }).total = 0;
    }).toThrow(TypeError);
  });

  it("rejects malformed JSON", async () => {
    const { c } = client([() => new Response("<html>oops</html>", { status: 200 })]);
    await expectApiError(c.searchWorks(search), "invalid_response");
  });

  it("treats a connection dropped mid-body as a retryable network error", async () => {
    const dropped = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket hang up"));
          },
        }),
        { status: 200 },
      );
    const { c, fake } = client([dropped, json(fixture("search-works"))]);
    await expect(c.searchWorks(search)).resolves.toBeTruthy();
    expect(fake.calls).toHaveLength(2);
  });

  it("rejects a body with no content", async () => {
    const { c } = client([() => new Response(null, { status: 200 })]);
    await expectApiError(c.searchWorks(search), "invalid_response");
  });

  it("rejects a response that fails the schema and logs the issues without the key", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (l) => lines.push(l), redact: (s) => s });
    const { c } = client([json({ results: "nope", page: 1, per_page: 20, total: 0 })], { logger });
    await expectApiError(c.searchWorks(search), "invalid_response");
    const logged = lines.join("");
    expect(logged).toContain("failed schema validation");
    expect(logged).toContain("results");
    expect(logged).not.toContain(KEY);
  });

  it("refuses a declared oversized body without reading it", async () => {
    const { c } = client([json(fixture("search-works"), 200, { "content-length": "999999999" })], {
      maxBodyBytes: 1000,
    });
    const e = await expectApiError(c.searchWorks(search), "response_too_large");
    expect(e.message).toContain("1000-byte");
  });

  it("aborts a streamed body once it exceeds the limit", async () => {
    const big = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(600));
          },
        }),
        { status: 200 },
      );
    const { c } = client([big], { maxBodyBytes: 1000 });
    await expectApiError(c.searchWorks(search), "response_too_large");
  });
});

describe("quota tracking", () => {
  it("records rate-limit headers from responses", async () => {
    const { c } = client([json(fixture("version-latest"))]);
    expect(c.quota).toBeUndefined();
    await c.getVersion(VERSION_ID);
    expect(c.quota).toEqual({
      limit: 10000,
      remaining: 9876,
      resetEpochSeconds: 1793617200,
      observedAt: 1_000_000,
    });
  });

  it("never raises remaining within one quota period (out-of-order responses)", async () => {
    const { c } = client([
      json(fixture("version-latest"), 200, { ...RATE_HEADERS, "x-ratelimit-remaining": "100" }),
      json(fixture("version-latest"), 200, { ...RATE_HEADERS, "x-ratelimit-remaining": "105" }),
      json(fixture("version-latest"), 200, {
        ...RATE_HEADERS,
        "x-ratelimit-remaining": "9999",
        "x-ratelimit-reset": "1793703600",
      }),
    ]);
    await c.getVersion(VERSION_ID);
    await c.getVersion(VERSION_ID);
    expect(c.quota?.remaining).toBe(100);
    await c.getVersion(VERSION_ID); // new period: may rise
    expect(c.quota?.remaining).toBe(9999);
  });

  it("ignores a late response from an earlier quota period", async () => {
    const { c } = client([
      json(fixture("version-latest"), 200, {
        ...RATE_HEADERS,
        "x-ratelimit-remaining": "9999",
        "x-ratelimit-reset": "1793703600",
      }),
      json(fixture("version-latest"), 200, { ...RATE_HEADERS, "x-ratelimit-remaining": "3" }),
    ]);
    await c.getVersion(VERSION_ID);
    await c.getVersion(VERSION_ID);
    expect(c.quota).toMatchObject({ remaining: 9999, resetEpochSeconds: 1793703600 });
  });

  it("leaves quota unknown on a 429 when nothing was seen before", async () => {
    const { c } = client([status(429)]);
    await expectApiError(c.getVersion(VERSION_ID), "daily_quota_exceeded");
    expect(c.quota).toBeUndefined();
  });

  it.each([
    {},
    { ...RATE_HEADERS, "x-ratelimit-remaining": "lots" },
    { ...RATE_HEADERS, "x-ratelimit-limit": "-1" },
  ])("ignores missing or malformed headers %j", async (headers) => {
    const { c } = client([json(fixture("version-latest"), 200, headers)]);
    await c.getVersion(VERSION_ID);
    expect(c.quota).toBeUndefined();
  });
});

describe("circuit breaker", () => {
  it("opens after repeated upstream failures and closes after the cooldown", async () => {
    const { c, fake, advance } = client(
      [status(500), status(500), json(fixture("version-latest"))],
      { circuitThreshold: 2, circuitCooldownMs: 10_000 },
    );
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    const open = await expectApiError(c.getVersion(VERSION_ID), "circuit_open");
    expect(open.message).toContain("10 s");
    expect(fake.calls).toHaveLength(2);
    advance(10_001);
    await expect(c.getVersion(VERSION_ID)).resolves.toBeTruthy();
  });

  it("lets exactly one probe through when half-open, failing others fast", async () => {
    let release: (r: Response) => void = () => undefined;
    let clock = 0;
    const responses: (() => Promise<Response>)[] = [
      () => Promise.resolve(status(500)()),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ];
    const fetchFn = vi.fn(() =>
      (responses.shift() ?? (() => Promise.reject(new Error("extra"))))(),
    );
    const c = new LegislationClient({
      apiKey: new Secret(KEY),
      timeoutMs: 5000,
      fetch: fetchFn,
      circuitThreshold: 1,
      circuitCooldownMs: 1000,
      now: () => clock,
    });
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    clock += 1001;
    const probe = c.getVersion(VERSION_ID);
    await Promise.resolve();
    await expectApiError(c.listVersions({ work_id: "act_public_2007_97" }), "circuit_open");
    release(json(fixture("version-latest"))());
    await expect(probe).resolves.toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignores the outcome of a request that started before the circuit opened", async () => {
    let releaseSlow: (r: Response) => void = () => undefined;
    const responses: (() => Promise<Response>)[] = [
      () =>
        new Promise<Response>((resolve) => {
          releaseSlow = resolve;
        }),
      () => Promise.resolve(status(500)()),
    ];
    const fetchFn = vi.fn(() =>
      (responses.shift() ?? (() => Promise.reject(new Error("extra"))))(),
    );
    const c = new LegislationClient({
      apiKey: new Secret(KEY),
      timeoutMs: 5000,
      fetch: fetchFn,
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });
    const slow = c.getVersion(VERSION_ID);
    await expectApiError(c.listVersions({ work_id: "act_public_2007_97" }), "upstream_error"); // opens
    releaseSlow(json(fixture("version-latest"))());
    await expect(slow).resolves.toBeTruthy(); // stale success must not close the circuit
    await expectApiError(c.searchWorks(search), "circuit_open");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("re-opens immediately when the half-open probe fails", async () => {
    const { c, fake, advance } = client([status(500), status(500)], {
      circuitThreshold: 1,
      circuitCooldownMs: 1000,
    });
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error"); // opens
    advance(1001);
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error"); // probe fails
    await expectApiError(c.getVersion(VERSION_ID), "circuit_open"); // re-opened at once
    expect(fake.calls).toHaveLength(2);
  });

  it("closes when the half-open probe gets a non-fault answer such as 404", async () => {
    const { c, advance } = client([status(500), status(404), json(fixture("version-latest"))], {
      circuitThreshold: 1,
      circuitCooldownMs: 1000,
    });
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    advance(1001);
    await expectApiError(c.getVersion(VERSION_ID), "not_found");
    await expect(c.getVersion(VERSION_ID)).resolves.toBeTruthy();
  });

  it("does not count client errors (404) towards opening", async () => {
    const { c, fake } = client([status(404), status(404), status(404)], { circuitThreshold: 2 });
    for (let i = 0; i < 3; i += 1) {
      await expectApiError(c.getVersion(VERSION_ID), "not_found");
    }
    expect(fake.calls).toHaveLength(3);
  });

  it("resets the failure count after a success", async () => {
    const { c } = client(
      [status(500), json(fixture("version-latest")), status(500), json(fixture("version-latest"))],
      { circuitThreshold: 2 },
    );
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    await c.getVersion(VERSION_ID);
    await expectApiError(c.getVersion(VERSION_ID), "upstream_error");
    await expect(c.getVersion(VERSION_ID)).resolves.toBeTruthy();
  });
});

describe("coalescing and caching", () => {
  it("shares one request between identical concurrent calls", async () => {
    const { c, fake } = client([json(fixture("version-latest"))]);
    const [a, b] = await Promise.all([c.getVersion(VERSION_ID), c.getVersion(VERSION_ID)]);
    expect(a).toBe(b);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not store responses when no cache is configured", async () => {
    const { c, fake } = client([json(fixture("version-latest")), json(fixture("version-latest"))]);
    await c.getVersion(VERSION_ID);
    await c.getVersion(VERSION_ID);
    expect(fake.calls).toHaveLength(2);
  });

  it("serves from the optional memory cache until the TTL passes", async () => {
    let now = 0;
    const cache = new MemoryCache(10, () => now);
    const { c, fake } = client([json(fixture("version-latest")), json(fixture("version-latest"))], {
      cache,
    });
    await c.getVersion(VERSION_ID);
    await c.getVersion(VERSION_ID);
    expect(fake.calls).toHaveLength(1);
    now += CACHE_TTL_MS.version + 1;
    await c.getVersion(VERSION_ID);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("defaults", () => {
  it("uses global fetch, real timers and Math.random when not injected", async () => {
    const fake = fakeFetch(status(503), json(fixture("version-latest")));
    vi.stubGlobal("fetch", fake.fn);
    const c = new LegislationClient({
      apiKey: new Secret(KEY),
      timeoutMs: 1000,
      backoffBaseMs: 1,
      backoffCapMs: 2,
    });
    await expect(c.getVersion(VERSION_ID)).resolves.toBeTruthy();
    expect(fake.calls).toHaveLength(2);
  });
});
