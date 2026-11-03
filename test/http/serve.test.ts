import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { serveHttp, type HttpIo } from "../../src/http/serve.js";
import { DUMMY_KEY } from "../dummy-key.js";
import { fakeFetch } from "../api/fake-fetch.js";

const remote = {
  LEGISLATION_NZ_API_KEY: DUMMY_KEY,
  LEGISLATION_NZ_HTTP_HOST: "0.0.0.0",
  LEGISLATION_NZ_PUBLIC_URL: "https://mcp.example.com/mcp",
  LEGISLATION_NZ_OAUTH_ISSUER: "https://auth.example.com/",
  LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS: "me",
};
const metadata =
  (extra: Record<string, unknown> = {}) =>
  () =>
    new Response(
      JSON.stringify({
        issuer: "https://auth.example.com/",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        jwks_uri: "https://auth.example.com/jwks",
        ...extra,
      }),
      { status: 200 },
    );

function io(
  env: Record<string, string>,
  fetchFn: typeof fetch = fakeFetch().fn,
  listenImpl?: HttpIo["listen"],
) {
  const stderr: string[] = [];
  const handlers = new Map<string, () => void>();
  const rejections: ((r: unknown) => void)[] = [];
  const close = vi.fn();
  const listen =
    listenImpl ??
    (vi.fn(() => Promise.resolve({ close } as unknown as Server)) satisfies HttpIo["listen"]);
  const value: HttpIo = {
    env,
    stderr: (t) => stderr.push(t),
    stdout: (t) => stderr.push(t),
    stdin: process.stdin,
    serve: () => ({ close: () => Promise.resolve() }),
    onSignal: (s, h) => handlers.set(s, h),
    onUnhandledRejection: (h) => rejections.push(h),
    listen,
    fetch: fetchFn,
  };
  return { value, stderr, handlers, rejections, close, listen };
}

describe("serveHttp", () => {
  it("fails clearly on configuration problems", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: DUMMY_KEY, LEGISLATION_NZ_HTTP_HOST: "0.0.0.0" });
    expect(await serveHttp(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("Remote HTTP mode requires OAuth");
    expect(
      await serveHttp(
        io({ XDG_CONFIG_HOME: "/nonexistent-nzlm-test", APPDATA: "/nonexistent-nzlm-test" }).value,
      ),
    ).toBe(1);
  });

  it("rethrows unexpected start-up errors", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: DUMMY_KEY });
    const broken = {
      ...t.value,
      stderr: () => {
        throw new Error("stderr closed");
      },
    };
    await expect(serveHttp(broken)).rejects.toThrow("stderr closed");
  });

  it("fails clearly when the authorization server cannot be discovered", async () => {
    const t = io(remote, fakeFetch(new TypeError("down"), new TypeError("down")).fn);
    expect(await serveHttp(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("Could not discover the authorization server metadata");
  });

  it("requires a JWKS URL when the authorization server publishes none", async () => {
    const t = io(remote, fakeFetch(metadata({ jwks_uri: undefined })).fn);
    expect(await serveHttp(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("publishes no jwks_uri");
  });

  it("starts with OAuth, logs without the key, and shuts down on signals", async () => {
    const t = io(remote, fakeFetch(metadata()).fn);
    expect(await serveHttp(t.value)).toBeUndefined();
    const logged = t.stderr.join("");
    expect(logged).toContain('"message":"listening"');
    expect(logged).toContain('"oauth":true');
    expect(logged).not.toContain(DUMMY_KEY);
    t.rejections[0]?.(new Error("stray"));
    t.handlers.get("SIGTERM")?.();
    expect(t.close).toHaveBeenCalled();
    expect(t.stderr.join("")).toContain("unhandled promise rejection");
  });

  it("logs why a token was refused, without the token", async () => {
    let handler: Parameters<HttpIo["listen"]>[0] | undefined;
    const listen: HttpIo["listen"] = (h) => {
      handler = h;
      return Promise.resolve({ close: vi.fn() } as unknown as Server);
    };
    const t = io(remote, fakeFetch(metadata()).fn, listen);
    expect(await serveHttp(t.value)).toBeUndefined();
    const res = await handler?.(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { host: "mcp.example.com", authorization: "Bearer not.a.jwt" },
        body: "{}",
      }),
      { remoteAddress: "192.0.2.1" },
    );
    expect(res?.status).toBe(401);
    const logged = t.stderr.join("");
    expect(logged).toContain('"message":"access token refused"');
    expect(logged).toContain('"code":"ERR_JWS_INVALID"');
    expect(logged).not.toContain("not.a.jwt");
  });

  it("uses a configured JWKS URL instead of the discovered one", async () => {
    const t = io(
      { ...remote, LEGISLATION_NZ_OAUTH_JWKS_URL: "https://keys.example.com/jwks" },
      fakeFetch(metadata({ jwks_uri: undefined })).fn,
    );
    expect(await serveHttp(t.value)).toBeUndefined();
  });

  it("refuses signing keys over plain http", async () => {
    const t = io(remote, fakeFetch(metadata({ jwks_uri: "http://attacker.example/jwks" })).fn);
    expect(await serveHttp(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("Refusing to fetch signing keys over plain http");
  });

  it("warns when the token audience differs from the public URL", async () => {
    const t = io(
      { ...remote, LEGISLATION_NZ_OAUTH_AUDIENCE: "api://legislation" },
      fakeFetch(metadata()).fn,
    );
    expect(await serveHttp(t.value)).toBeUndefined();
    expect(t.stderr.join("")).toContain("token audience differs from the public URL");
  });

  it("starts on loopback without OAuth and warns", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: DUMMY_KEY });
    expect(await serveHttp(t.value)).toBeUndefined();
    expect(t.stderr.join("")).toContain("no authentication");
  });

  it("reports a port that cannot be bound", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: DUMMY_KEY }, fakeFetch().fn, () =>
      Promise.reject(new Error("EADDRINUSE")),
    );
    expect(await serveHttp(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("Could not listen on 127.0.0.1:8080 (EADDRINUSE)");
  });
});
