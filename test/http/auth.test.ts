import { OAuthError } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createJwtVerifier, discoverAuthorizationServer, remoteKeys } from "../../src/http/auth.js";
import { fakeFetch } from "../api/fake-fetch.js";
import { ISSUER, RESOURCE, SUBJECT, testKeys } from "./keys.js";

const resource = new URL(RESOURCE);

async function verifier(requireAtJwt = false) {
  const k = await testKeys();
  return {
    ...k,
    verify: createJwtVerifier({
      issuer: ISSUER,
      audience: RESOURCE,
      requireAtJwt,
      resource,
      keys: k.keys,
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const e = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(OAuthError);
  return (e as OAuthError).message;
}

describe("createJwtVerifier", () => {
  it("accepts a valid token and maps it to AuthInfo", async () => {
    const v = await verifier();
    const token = await v.mint({ client_id: "chatgpt-connector", scope: "mcp read" });
    const info = await v.verify.verifyAccessToken(token);
    expect(info).toMatchObject({
      token,
      clientId: "chatgpt-connector",
      scopes: ["mcp", "read"],
      resource,
    });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("reads scp arrays and azp, and falls back to the subject", async () => {
    const v = await verifier();
    expect(
      await v.verify.verifyAccessToken(
        await v.mint({ scope: undefined, scp: ["a", 1, "b"], azp: "app" }),
      ),
    ).toMatchObject({
      clientId: "app",
      scopes: ["a", "b"],
    });
    expect(await v.verify.verifyAccessToken(await v.mint({ scope: undefined }))).toMatchObject({
      clientId: SUBJECT,
      scopes: [],
    });
  });

  it.each([
    [{ iss: "https://evil.example.com/" }, "not valid for this server"],
    [{ aud: "https://other.example.com/mcp" }, "not valid for this server"],
    [{ sub: ["alice"] }, "not valid for this server"],
  ])("rejects %j", async (claims, message) => {
    const v = await verifier();
    expect(await rejection(v.verify.verifyAccessToken(await v.mint(claims)))).toContain(message);
  });

  it("returns the verified subject for the app's allow-list", async () => {
    const v = await verifier();
    expect((await v.verify.verifyAccessToken(await v.mint({ sub: "someone-else" }))).extra).toEqual(
      {
        subject: "someone-else",
      },
    );
  });

  it("rejects tokens older than 24 hours, and requires at+jwt when configured", async () => {
    const v = await verifier();
    const old = await v.mint(
      { iat: Math.floor(Date.now() / 1000) - 2 * 86_400 },
      { expiresIn: "100y" },
    );
    expect(await rejection(v.verify.verifyAccessToken(old))).toContain("expired");
    const strict = await verifier(true);
    expect(await rejection(strict.verify.verifyAccessToken(await strict.mint()))).toContain(
      "not valid",
    );
    expect(
      await strict.verify.verifyAccessToken(await strict.mint({}, { typ: "at+jwt" })),
    ).toBeTruthy();
  });

  it("rejects expired tokens with a clear message", async () => {
    const v = await verifier();
    const token = await v.mint({}, { expiresIn: Math.floor(Date.now() / 1000) - 120 });
    expect(await rejection(v.verify.verifyAccessToken(token))).toContain("expired");
  });

  it("reports the reason for a refusal (class and code only)", async () => {
    const reasons: { error: string; code: string }[] = [];
    const make = (keys: Parameters<typeof createJwtVerifier>[0]["keys"]) =>
      createJwtVerifier({
        issuer: ISSUER,
        audience: RESOURCE,
        resource,
        keys,
        onReject: (r) => reasons.push(r),
      });
    const k = await testKeys();
    const token = await k.mint();
    await rejection(make(k.keys).verifyAccessToken("not.a.jwt"));
    await rejection(
      make(() => {
        throw new TypeError("network down");
      }).verifyAccessToken(token),
    );
    await rejection(
      make(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a hostile key source
        throw "odd";
      }).verifyAccessToken(token),
    );
    // A signed token whose subject is empty passes jose's checks but not ours.
    await rejection(make(k.keys).verifyAccessToken(await k.mint({ sub: "" })));
    expect(reasons).toEqual([
      { error: "JWSInvalid", code: "ERR_JWS_INVALID" },
      { error: "TypeError", code: "error" },
      { error: "unknown", code: "unknown" },
      { error: "JWTClaimValidationFailed", code: "missing_sub" },
    ]);
    expect(JSON.stringify(reasons)).not.toContain(token);
  });

  it("rejects garbage and tokens signed with another key", async () => {
    const v = await verifier();
    const other = await testKeys();
    expect(await rejection(v.verify.verifyAccessToken("not.a.jwt"))).toContain("not valid");
    expect(await rejection(v.verify.verifyAccessToken(await other.mint()))).toContain("not valid");
  });

  it("accepts only https (or loopback http) key URLs", async () => {
    const { isSecureKeyUrl } = await import("../../src/http/auth.js");
    expect(isSecureKeyUrl(new URL("https://auth.example.com/jwks"))).toBe(true);
    expect(isSecureKeyUrl(new URL("http://localhost:9000/jwks"))).toBe(true);
    expect(isSecureKeyUrl(new URL("http://attacker.example/jwks"))).toBe(false);
    expect(isSecureKeyUrl(new URL("ftp://auth.example.com/jwks"))).toBe(false);
  });

  it("builds a remote key source", () => {
    expect(typeof remoteKeys(new URL("https://auth.example.com/jwks"))).toBe("function");
  });
});

describe("discoverAuthorizationServer", () => {
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    jwks_uri: "https://auth.example.com/jwks",
  };
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it("uses RFC 8414 metadata first", async () => {
    const fake = fakeFetch(ok(metadata));
    const m = await discoverAuthorizationServer(new URL(ISSUER), fake.fn);
    expect(m).toMatchObject({ jwks_uri: metadata.jwks_uri, response_types_supported: ["code"] });
    expect(fake.calls[0]?.url).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server",
    );
  });

  it("falls back to OpenID discovery (with an issuer path)", async () => {
    const tenant = {
      ...metadata,
      issuer: "https://login.example.com/tenant/v2.0",
      response_types_supported: ["code", "id_token"],
    };
    const fake = fakeFetch(() => new Response("", { status: 404 }), ok(tenant));
    const m = await discoverAuthorizationServer(
      new URL("https://login.example.com/tenant/v2.0"),
      fake.fn,
    );
    expect(m.response_types_supported).toEqual(["code", "id_token"]);
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://login.example.com/.well-known/oauth-authorization-server/tenant/v2.0",
      "https://login.example.com/tenant/v2.0/.well-known/openid-configuration",
    ]);
  });

  it("refuses metadata for a different issuer (mix-up defence)", async () => {
    const fake = fakeFetch(ok({ ...metadata, issuer: "https://evil.example.com/" }));
    await expect(discoverAuthorizationServer(new URL(ISSUER), fake.fn)).rejects.toThrow(
      "says its issuer is https://evil.example.com/",
    );
  });

  it("refuses oversized or non-JSON metadata", async () => {
    const huge = () =>
      new Response(JSON.stringify({ ...metadata, pad: "x".repeat(70_000) }), { status: 200 });
    const notJson = () => new Response("<html>", { status: 200 });
    const fake = fakeFetch(huge, notJson);
    await expect(discoverAuthorizationServer(new URL(ISSUER), fake.fn)).rejects.toThrow(
      "metadata too large; https://auth.example.com/.well-known/openid-configuration: not valid authorization server metadata",
    );
  });

  it("stops reading an endless discovery response at the size cap", async () => {
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
          },
        }),
        { status: 200 },
      );
    const empty = () => new Response(null, { status: 200 });
    await expect(
      discoverAuthorizationServer(new URL(ISSUER), fakeFetch(endless, empty).fn),
    ).rejects.toThrow(
      "metadata too large; https://auth.example.com/.well-known/openid-configuration: not valid authorization server metadata",
    );
  });

  it("explains when nothing usable is found", async () => {
    const fake = fakeFetch(ok({ issuer: ISSUER }), new TypeError("down"));
    await expect(discoverAuthorizationServer(new URL(ISSUER), fake.fn)).rejects.toThrow(
      "not valid authorization server metadata; https://auth.example.com/.well-known/openid-configuration: unreachable",
    );
  });

  it("uses global fetch by default", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", fakeFetch(ok(metadata)).fn);
    await expect(discoverAuthorizationServer(new URL(ISSUER))).resolves.toBeTruthy();
  });
});
