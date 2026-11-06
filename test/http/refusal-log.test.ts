// Refused requests are logged once per reason per minute, with a subject hash and never a raw
// subject or IP address (issue #44, OBS-01).
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createJwtVerifier } from "../../src/http/auth.js";
import { createHttpApp, subjectHash, type HttpApp } from "../../src/http/app.js";
import { loadHttpConfig } from "../../src/http/config.js";
import type { Logger } from "../../src/logger.js";
import { deps } from "../tools/harness.js";
import { ISSUER, RESOURCE, SUBJECT, testKeys } from "./keys.js";

const AS: OAuthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  response_types_supported: ["code"],
};

interface Captured {
  readonly level: string;
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

function capture(): { logger: Logger; records: Captured[] } {
  const records: Captured[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      records.push({ level, message, fields });
    };
  return {
    records,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

let apps: HttpApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

let clock = 0;
const now = (): number => clock;

async function oauthApp(rateLimit = "60") {
  clock = 1_000_000;
  const k = await testKeys();
  const { logger, records } = capture();
  const app = createHttpApp({
    config: loadHttpConfig({
      LEGISLATION_NZ_HTTP_HOST: "0.0.0.0",
      LEGISLATION_NZ_PUBLIC_URL: RESOURCE,
      LEGISLATION_NZ_OAUTH_ISSUER: ISSUER,
      LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS: SUBJECT,
      LEGISLATION_NZ_ALLOWED_ORIGINS: "chatgpt.com",
      LEGISLATION_NZ_RATE_LIMIT_PER_MINUTE: rateLimit,
    }),
    deps: deps([]).deps,
    logger,
    now,
    auth: {
      verifier: createJwtVerifier({
        issuer: ISSUER,
        audience: RESOURCE,
        resource: new URL(RESOURCE),
        keys: k.keys,
      }),
      authorizationServer: AS,
    },
  });
  apps.push(app);
  return { app, k, records };
}

const IP = "203.0.113.77";

const request = (path: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`https://mcp.example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "mcp.example.com", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
  });

const refusals = (records: readonly Captured[]) =>
  records.filter((r) => r.message === "request refused");

/** No record may contain the raw subject or any client address. */
function expectNoPersonalData(records: readonly Captured[]): void {
  const text = JSON.stringify(records);
  for (const forbidden of ["intruder", SUBJECT, IP, "203.0.113", "127.0.0.1"]) {
    expect(text).not.toContain(forbidden);
  }
}

describe("subjectHash", () => {
  it("matches the documented shell one-liner (printf %s sub | sha256sum | cut -c1-12)", () => {
    expect(subjectHash("intruder")).toBe("aedad4dfac47");
    expect(subjectHash(SUBJECT)).toBe("dd15160ea47c");
  });
});

describe("refusal logging", () => {
  it("logs a refused subject with its hash, once per minute, counting the rest", async () => {
    const { app, k, records } = await oauthApp();
    const token = await k.mint({ sub: "intruder" });
    const post = () =>
      app.fetch(request("/mcp", { authorization: `Bearer ${token}` }, "{}"), {
        remoteAddress: IP,
      });
    expect((await post()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(refusals(records)).toEqual([
      {
        level: "warn",
        message: "request refused",
        fields: { reason: "subject_not_allowed", subjectHash: "aedad4dfac47" },
      },
    ]);
    clock += 60_000;
    expect((await post()).status).toBe(403);
    expect(refusals(records).at(-1)?.fields).toEqual({
      reason: "subject_not_allowed",
      subjectHash: "aedad4dfac47",
      suppressedSinceLast: 2,
    });
    expectNoPersonalData(records);
  });

  it("throttles each reason separately", async () => {
    const { app, records } = await oauthApp();
    await app.fetch(request("/healthz", { host: "evil.example" }), { remoteAddress: IP });
    await app.fetch(request("/mcp", { origin: "https://evil.example" }, "{}"), {
      remoteAddress: IP,
    });
    await app.fetch(request("/healthz", { host: "evil.example" }), { remoteAddress: IP });
    expect(refusals(records).map((r) => r.fields)).toEqual([
      { reason: "host_rejected" },
      { reason: "origin_rejected" },
    ]);
    expectNoPersonalData(records);
  });

  it("logs per-IP and per-subject rate limits", async () => {
    const { app, k, records } = await oauthApp("1"); // per subject 1, per IP 5 a minute
    for (let i = 0; i < 6; i += 1) await app.fetch(request("/healthz"), { remoteAddress: IP });
    const token = await k.mint();
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    await app.fetch(request("/mcp", headers, body), { remoteAddress: IP });
    expect((await app.fetch(request("/mcp", headers, body), { remoteAddress: IP })).status).toBe(
      429,
    );
    expect(refusals(records).map((r) => r.fields)).toEqual([
      { reason: "rate_limited_ip" },
      { reason: "rate_limited_subject", subjectHash: "dd15160ea47c" },
    ]);
    expectNoPersonalData(records);
  });

  it("logs failed authentication only once the per-IP limit is reached", async () => {
    const { app, records } = await oauthApp("1");
    const post = () =>
      app.fetch(request("/mcp", { authorization: "Bearer junk" }, "{}"), { remoteAddress: IP });
    for (let i = 0; i < 5; i += 1) expect((await post()).status).toBe(401);
    expect(refusals(records)).toEqual([]);
    expect((await post()).status).toBe(429);
    expect(refusals(records).map((r) => r.fields)).toEqual([{ reason: "rate_limited_ip" }]);
  });

  it("logs a refused subject that has also hit the per-IP limit as a rate limit", async () => {
    const { app, k, records } = await oauthApp("1");
    const token = await k.mint({ sub: "intruder" });
    const post = () =>
      app.fetch(request("/mcp", { authorization: `Bearer ${token}` }, "{}"), {
        remoteAddress: IP,
      });
    for (let i = 0; i < 5; i += 1) await post();
    expect((await post()).status).toBe(429);
    expect(refusals(records).map((r) => r.fields?.["reason"])).toEqual([
      "subject_not_allowed",
      "rate_limited_ip",
    ]);
  });

  it("logs batches and oversized bodies", async () => {
    const { app, k, records } = await oauthApp();
    const headers = { authorization: `Bearer ${await k.mint()}` };
    await app.fetch(request("/mcp", headers, "[{}]"), { remoteAddress: IP });
    await app.fetch(request("/mcp", headers, `"${"a".repeat(4 * 1024 * 1024)}"`), {
      remoteAddress: IP,
    });
    expect(refusals(records).map((r) => r.fields)).toEqual([
      { reason: "batch_rejected", subjectHash: "dd15160ea47c" },
      { reason: "payload_too_large", subjectHash: "dd15160ea47c" },
    ]);
  });
});

describe("refusal logging without OAuth", () => {
  it("logs refused non-local connections, with no subject or address", async () => {
    const { logger, records } = capture();
    const app = createHttpApp({ config: loadHttpConfig({}), deps: deps([]).deps, logger, now });
    apps.push(app);
    const res = await app.fetch(
      new Request("http://localhost:8080/healthz", {
        headers: { host: "localhost:8080", "x-forwarded-for": IP },
      }),
      { remoteAddress: "127.0.0.1" },
    );
    expect(res.status).toBe(403);
    // A local rate limit records no subject hash: "local" is a stand-in, not an account.
    expect(refusals(records).map((r) => r.fields)).toEqual([{ reason: "not_local" }]);
    expectNoPersonalData(records);
  });

  it("does not hash the local stand-in subject when rate-limiting", async () => {
    const { logger, records } = capture();
    const app = createHttpApp({
      config: loadHttpConfig({ LEGISLATION_NZ_RATE_LIMIT_PER_MINUTE: "1" }),
      deps: deps([]).deps,
      logger,
      now,
    });
    apps.push(app);
    const post = () =>
      app.fetch(
        new Request("http://localhost:8080/mcp", {
          method: "POST",
          headers: { host: "localhost:8080", "content-type": "application/json" },
          body: "[{}]",
        }),
        { remoteAddress: "127.0.0.1" },
      );
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(429);
    expect(refusals(records).map((r) => r.fields)).toEqual([
      { reason: "batch_rejected" },
      { reason: "rate_limited_subject" },
    ]);
  });
});
