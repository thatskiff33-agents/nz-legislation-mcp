// The HTTP app end to end through the official MCP client (its fetch is the app itself).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createJwtVerifier } from "../../src/http/auth.js";
import { createHttpApp, type HttpApp } from "../../src/http/app.js";
import { loadHttpConfig } from "../../src/http/config.js";
import { silentLogger } from "../../src/logger.js";
import { deps } from "../tools/harness.js";
import { ISSUER, RESOURCE, SUBJECT, testKeys } from "./keys.js";

const AS: OAuthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  response_types_supported: ["code"],
};

let apps: HttpApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function oauthApp(rateLimit = "60", extra: Record<string, string> = {}) {
  const k = await testKeys();
  const config = loadHttpConfig({
    ...extra,
    LEGISLATION_NZ_HTTP_HOST: "0.0.0.0",
    LEGISLATION_NZ_PUBLIC_URL: RESOURCE,
    LEGISLATION_NZ_OAUTH_ISSUER: ISSUER,
    LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS: SUBJECT,
    LEGISLATION_NZ_OAUTH_REQUIRED_SCOPES: "mcp",
    LEGISLATION_NZ_ALLOWED_ORIGINS: "chatgpt.com",
    LEGISLATION_NZ_RATE_LIMIT_PER_MINUTE: rateLimit,
  });
  const verifier = createJwtVerifier({
    issuer: ISSUER,
    audience: RESOURCE,
    resource: new URL(RESOURCE),
    keys: k.keys,
  });
  const app = createHttpApp({
    config,
    deps: deps([]).deps,
    logger: silentLogger,
    auth: { verifier, authorizationServer: AS },
  });
  apps.push(app);
  return { app, k };
}

/** Direct connection from this machine. */
const LOCAL = { remoteAddress: "127.0.0.1" };

const request = (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) => {
  const { headers = {}, ...rest } = init;
  return new Request(`https://mcp.example.com${path}`, {
    ...rest,
    headers: { host: "mcp.example.com", ...headers },
  });
};

/** In-memory requests lack the Host header a real HTTP request always carries; add it. */
function viaApp(
  app: HttpApp,
  host: string,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const original = new Request(input, init);
    const headers = new Headers(original.headers);
    headers.set("host", host);
    return app.fetch(new Request(original, { headers }), LOCAL);
  };
}

async function connect(app: HttpApp, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: viaApp(app, "mcp.example.com"),
    requestInit: token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  return client;
}

describe("HTTP app with OAuth", () => {
  it("answers health checks with security headers", async () => {
    const { app } = await oauthApp();
    const res = await app.fetch(request("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("publishes RFC 9728 protected-resource metadata", async () => {
    const { app } = await oauthApp();
    const res = await app.fetch(request("/.well-known/oauth-protected-resource/mcp"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["mcp"],
    });
  });

  it("challenges requests without a token, pointing at the metadata", async () => {
    const { app } = await oauthApp();
    const res = await app.fetch(
      request("/mcp", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("refuses tokens without the required scope and tokens for other subjects", async () => {
    const { app, k } = await oauthApp();
    const noScope = await k.mint({ scope: "read" });
    const res = await app.fetch(
      request("/mcp", {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${noScope}`, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(403);
    const other = await k.mint({ sub: "intruder" });
    const res2 = await app.fetch(
      request("/mcp", {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
      }),
    );
    expect(res2.status).toBe(403);
  });

  it("counts refused subjects against the per-IP limit", async () => {
    const { app, k } = await oauthApp("1"); // per-IP: 5 a minute
    const other = await k.mint({ sub: "intruder" });
    const post = () =>
      app.fetch(
        request("/mcp", {
          method: "POST",
          body: "{}",
          headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
        }),
        { remoteAddress: "192.0.2.50" },
      );
    for (let i = 0; i < 5; i += 1) expect((await post()).status).toBe(403);
    expect((await post()).status).toBe(429);
  });

  it("keeps OAuth discovery on its own per-IP bucket", async () => {
    const { app } = await oauthApp("1");
    const from = { remoteAddress: "192.0.2.60" };
    for (let i = 0; i < 5; i += 1) await app.fetch(request("/healthz"), from);
    expect((await app.fetch(request("/healthz"), from)).status).toBe(429);
    const discovery = await app.fetch(request("/.well-known/oauth-protected-resource/mcp"), from);
    expect(discovery.status).toBe(200);
  });

  it("groups IPv6 clients by /64 for per-IP limits", async () => {
    const { app } = await oauthApp("1");
    const health = (remoteAddress: string) => app.fetch(request("/healthz"), { remoteAddress });
    for (let i = 0; i < 5; i += 1) await health(`2001:db8::${String(i + 1)}`);
    // Same /64, written in full or compressed differently: limited.
    expect((await health("2001:0db8:0000:0000:1:2:3:4")).status).toBe(429);
    expect((await health("2001:db8:0:0::ffff")).status).toBe(429);
    // Another /64, and an address starting with "::": separate buckets.
    expect((await health("2001:db8:0:1::1")).status).toBe(200);
    expect((await health("::2")).status).toBe(200);
    expect((await health("2001:db8:0:2::")).status).toBe(200);
  });

  it("serves MCP to the key holder through the official client", async () => {
    const { app, k } = await oauthApp();
    const client = await connect(app, await k.mint());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_provision_text");
    const quota = await client.callTool({ name: "get_api_quota", arguments: {} });
    expect(quota.structuredContent).toMatchObject({ known: false });
    await client.close();
  });

  it("rejects wrong Host headers and disallowed browser origins", async () => {
    const { app } = await oauthApp();
    expect(
      (
        await app.fetch(
          new Request("https://mcp.example.com/healthz", { headers: { host: "evil.example" } }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.fetch(request("/healthz", { headers: { origin: "https://evil.example" } })))
        .status,
    ).toBe(403);
    expect(
      (await app.fetch(request("/healthz", { headers: { origin: "https://chatgpt.com" } }))).status,
    ).toBe(200);
  });

  it("returns 404 for unknown paths", async () => {
    const { app } = await oauthApp();
    expect((await app.fetch(request("/admin"))).status).toBe(404);
  });

  it("rate-limits per client", async () => {
    let now = 0;
    const config = loadHttpConfig({ LEGISLATION_NZ_RATE_LIMIT_PER_MINUTE: "2" });
    const app = createHttpApp({
      config,
      deps: deps([]).deps,
      logger: silentLogger,
      now: () => now,
    });
    apps.push(app);
    const post = () =>
      app.fetch(
        new Request("http://localhost:8080/mcp", {
          method: "POST",
          headers: { host: "localhost:8080", "content-type": "application/json" },
          body: "{}",
        }),
        LOCAL,
      );
    expect((await post()).status).not.toBe(429);
    expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    now += 60_000;
    expect((await post()).status).not.toBe(429);
  });
});

describe("HTTP app abuse controls", () => {
  const post = (
    app: HttpApp,
    token: string,
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    ip = "203.0.113.1",
  ) =>
    app.fetch(
      request("/mcp", {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
      { remoteAddress: ip },
    );

  it("limits per user, so fresh OAuth client ids do not reset the limit", async () => {
    const { app, k } = await oauthApp("2");
    const statuses = [];
    for (let i = 0; i < 3; i += 1)
      statuses.push((await post(app, await k.mint({ client_id: `client-${String(i)}` }))).status);
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses[2]).toBe(429);
  });

  it("refuses JSON-RPC batches and oversized bodies", async () => {
    const { app, k } = await oauthApp();
    const token = await k.mint();
    const batch = await post(app, token, '  [{"jsonrpc":"2.0","id":1,"method":"tools/list"}]');
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: "batch_not_supported" });
    const big = await post(app, token, `{"x":"${"a".repeat(4 * 1024 * 1024)}"}`);
    expect(big.status).toBe(413);
  });

  it("passes an empty POST to the MCP handler, which rejects it", async () => {
    const { app, k } = await oauthApp();
    const res = await app.fetch(
      request("/mcp", { method: "POST", headers: { authorization: `Bearer ${await k.mint()}` } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("refuses an oversized body declared up front without reading it", async () => {
    const { app, k } = await oauthApp();
    const res = await app.fetch(
      request("/mcp", {
        method: "POST",
        body: "{}",
        headers: {
          authorization: `Bearer ${await k.mint()}`,
          "content-length": String(10 * 1024 * 1024),
        },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("rate-limits by IP before authentication", async () => {
    const { app } = await oauthApp("1"); // per-IP allowance is 5x the per-user limit
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (await app.fetch(request("/healthz"), { remoteAddress: "198.51.100.7" })).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await app.fetch(request("/healthz"), { remoteAddress: "198.51.100.8" })).status).toBe(
      200,
    );
  });

  it("limits failed authentication per IP, but never locks out the key holder", async () => {
    const { app, k } = await oauthApp("1"); // per-IP allowance 5 per minute
    const junk = () =>
      app.fetch(
        request("/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer junk" } }),
        {
          remoteAddress: "192.0.2.9",
        },
      );
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await junk()).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Same IP (e.g. a shared reverse proxy), valid owner token: still served.
    expect((await post(app, await k.mint(), undefined, "192.0.2.9")).status).not.toBe(429);
  });

  it("forbids a verified token that carries no subject", async () => {
    const config = loadHttpConfig({
      LEGISLATION_NZ_HTTP_HOST: "0.0.0.0",
      LEGISLATION_NZ_PUBLIC_URL: RESOURCE,
      LEGISLATION_NZ_OAUTH_ISSUER: ISSUER,
      LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS: SUBJECT,
    });
    const verifier = {
      verifyAccessToken: (token: string) =>
        Promise.resolve({
          token,
          clientId: "c",
          scopes: [],
          expiresAt: Date.now() / 1000 + 60,
          resource: new URL(RESOURCE),
        }),
    };
    const app = createHttpApp({
      config,
      deps: deps([]).deps,
      logger: silentLogger,
      auth: { verifier, authorizationServer: AS },
    });
    apps.push(app);
    expect((await post(app, "opaque")).status).toBe(403);
  });
});

describe("trusted proxy", () => {
  it("uses the last X-Forwarded-For entry only when the proxy is trusted", async () => {
    const make = async (trust: string) =>
      (await oauthApp("1", { LEGISLATION_NZ_TRUST_PROXY: trust })).app;
    const health = (app: HttpApp, xff?: string) =>
      app.fetch(
        request("/healthz", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } }),
        { remoteAddress: "10.0.0.2" }, // the proxy
      );
    // Trusted: each real client (last entry) gets its own allowance; spoofed earlier entries are ignored.
    const trusted = await make("true");
    for (let i = 0; i < 5; i += 1) await health(trusted, `spoofed-${String(i)}, 203.0.113.5`);
    expect((await health(trusted, "spoofed-x, 203.0.113.5")).status).toBe(429);
    expect((await health(trusted, "203.0.113.6")).status).toBe(200);
    expect((await health(trusted, " ")).status).toBe(200); // blank header: falls back to the socket
    // Not trusted: the header is ignored and the socket address is used.
    const untrusted = await make("false");
    for (let i = 0; i < 5; i += 1) await health(untrusted, `203.0.113.${String(i)}`);
    expect((await health(untrusted, "198.51.100.1")).status).toBe(429);
  });
});

describe("HTTP app on loopback without OAuth", () => {
  it("answers only loopback Host names (no tunnel or proxy access)", async () => {
    const app = createHttpApp({
      config: loadHttpConfig({}),
      deps: deps([]).deps,
      logger: silentLogger,
    });
    apps.push(app);
    const res = await app.fetch(
      new Request("http://localhost:8080/healthz", { headers: { host: "mcp.example.com" } }),
    );
    expect(res.status).toBe(403);
  });

  it("serves MCP locally with no token and no HSTS", async () => {
    const config = loadHttpConfig({});
    const app = createHttpApp({ config, deps: deps([]).deps, logger: silentLogger });
    apps.push(app);
    const res = await app.fetch(
      new Request("http://localhost:8080/healthz", { headers: { host: "localhost:8080" } }),
      LOCAL,
    );
    expect(res.headers.get("strict-transport-security")).toBeNull();
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8080/mcp"), {
      fetch: viaApp(app, "localhost:8080"),
    });
    const client = new Client({ name: "local", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBe(7);
    await client.close();
    expect(
      (
        await app.fetch(
          new Request("http://localhost:8080/.well-known/oauth-protected-resource/mcp", {
            headers: { host: "localhost:8080" },
          }),
          LOCAL,
        )
      ).status,
    ).toBe(404);
  });

  it("refuses proxied, tunnelled or remote connections", async () => {
    const app = createHttpApp({
      config: loadHttpConfig({}),
      deps: deps([]).deps,
      logger: silentLogger,
    });
    apps.push(app);
    const health = (headers: Record<string, string>, remoteAddress: string) =>
      app.fetch(
        new Request("http://localhost:8080/healthz", {
          headers: { host: "127.0.0.1:8080", ...headers },
        }),
        { remoteAddress },
      );
    // A proxy or tunnel that rewrites Host to a loopback name still adds its own headers.
    for (const header of ["x-forwarded-for", "forwarded", "via", "cf-connecting-ip", "x-real-ip"]) {
      const res = await health({ [header]: "203.0.113.9" }, "127.0.0.1");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toContain("configure OAuth");
    }
    // Another machine (or an unknown peer) is refused; loopback forms are accepted.
    expect((await health({}, "192.0.2.10")).status).toBe(403);
    expect((await health({}, "unknown")).status).toBe(403);
    for (const peer of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect((await health({}, peer)).status).toBe(200);
    }
  });

  it("refuses to build with OAuth configured but no verifier", () => {
    const config = loadHttpConfig({
      LEGISLATION_NZ_PUBLIC_URL: "http://localhost:8080/mcp",
      LEGISLATION_NZ_OAUTH_ISSUER: "http://localhost:9000/",
      LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS: "me",
    });
    expect(() => createHttpApp({ config, deps: deps([]).deps, logger: silentLogger })).toThrow(
      TypeError,
    );
  });

  it("turns unexpected failures into a 500 without details", async () => {
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      error: (m: string) => {
        lines.push(m);
      },
    };
    const app = createHttpApp({ config: loadHttpConfig({}), deps: deps([]).deps, logger });
    apps.push(app);
    const broken = new Request("http://localhost:8080/healthz", {
      headers: { host: "localhost:8080" },
    });
    Object.defineProperty(broken, "url", {
      get: () => {
        throw new Error("boom");
      },
    });
    const res = await app.fetch(broken, LOCAL);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(lines).toContain("unhandled http error");
  });
});
