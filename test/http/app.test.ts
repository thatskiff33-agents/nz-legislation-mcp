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

async function oauthApp(rateLimit = "60") {
  const k = await testKeys();
  const config = loadHttpConfig({
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
    allowedSubjects: [SUBJECT],
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
    return app.fetch(new Request(original, { headers }));
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
    expect(res2.status).toBe(401);
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

describe("HTTP app on loopback without OAuth", () => {
  it("serves MCP locally with no token and no HSTS", async () => {
    const config = loadHttpConfig({});
    const app = createHttpApp({ config, deps: deps([]).deps, logger: silentLogger });
    apps.push(app);
    const res = await app.fetch(
      new Request("http://localhost:8080/healthz", { headers: { host: "localhost:8080" } }),
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
        )
      ).status,
    ).toBe(404);
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
    const res = await app.fetch(broken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(lines).toContain("unhandled http error");
  });
});
