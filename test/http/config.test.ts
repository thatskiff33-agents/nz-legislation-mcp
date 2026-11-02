import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import { HTTP_ENV, isLoopback, loadHttpConfig } from "../../src/http/config.js";

const problems = (env: Record<string, string>): string => {
  try {
    loadHttpConfig(env);
    return "";
  } catch (e) {
    if (e instanceof ConfigError) return e.problems.join("\n");
    throw e;
  }
};

const remote = {
  [HTTP_ENV.host]: "0.0.0.0",
  [HTTP_ENV.publicUrl]: "https://mcp.example.com/mcp",
  [HTTP_ENV.issuer]: "https://auth.example.com/",
  [HTTP_ENV.allowedSubjects]: "user-1, user-2",
};

describe("loadHttpConfig", () => {
  it("defaults to loopback without OAuth", () => {
    const c = loadHttpConfig({});
    expect(c).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      loopback: true,
      oauth: undefined,
      rateLimitPerMinute: 60,
    });
    expect(c.resourceUrl.href).toBe("http://localhost:8080/mcp");
  });

  it("accepts a complete remote OAuth configuration", () => {
    const c = loadHttpConfig({
      ...remote,
      [HTTP_ENV.port]: "3000",
      [HTTP_ENV.requiredScopes]: "mcp legislation",
      [HTTP_ENV.allowedOrigins]: "chatgpt.com,claude.ai",
      [HTTP_ENV.jwksUrl]: "https://auth.example.com/jwks",
      [HTTP_ENV.rateLimit]: "120",
    });
    expect(c.loopback).toBe(false);
    expect(c.oauth).toMatchObject({
      audience: "https://mcp.example.com/mcp",
      allowedSubjects: ["user-1", "user-2"],
      requiredScopes: ["mcp", "legislation"],
    });
    expect(c.oauth?.jwksUrl?.href).toBe("https://auth.example.com/jwks");
    expect(c.allowedOrigins).toEqual(["chatgpt.com", "claude.ai"]);
    expect(c.rateLimitPerMinute).toBe(120);
  });

  it("reads the at+jwt requirement", () => {
    expect(loadHttpConfig({ ...remote, [HTTP_ENV.requireAtJwt]: "true" }).oauth?.requireAtJwt).toBe(
      true,
    );
    expect(loadHttpConfig(remote).oauth?.requireAtJwt).toBe(false);
  });

  it("uses a custom audience when given", () => {
    expect(
      loadHttpConfig({ ...remote, [HTTP_ENV.audience]: "api://legislation" }).oauth?.audience,
    ).toBe("api://legislation");
  });

  it.each([
    [{ [HTTP_ENV.host]: "0.0.0.0" }, "requires OAuth"],
    [
      { [HTTP_ENV.publicUrl]: "https://mcp.example.com/mcp" },
      "A tunnel or reverse proxy in front of a loopback server is remote too",
    ],
    [
      { ...remote, [HTTP_ENV.publicUrl]: "http://localhost/mcp" },
      "must use https (except for a loopback-only server)",
    ],
    [{ [HTTP_ENV.host]: "0.0.0.0" }, `${HTTP_ENV.publicUrl} is required when binding`],
    [{ ...remote, [HTTP_ENV.allowedSubjects]: "" }, `${HTTP_ENV.allowedSubjects} is required`],
    [{ ...remote, [HTTP_ENV.publicUrl]: "http://mcp.example.com/mcp" }, "must use https"],
    [{ ...remote, [HTTP_ENV.publicUrl]: "https://mcp.example.com/other" }, "must end with /mcp"],
    [
      { ...remote, [HTTP_ENV.publicUrl]: "https://u:p@mcp.example.com/mcp" },
      "must not contain credentials",
    ],
    [{ ...remote, [HTTP_ENV.publicUrl]: "not a url" }, "is not a valid URL"],
    [
      { ...remote, [HTTP_ENV.issuer]: "http://auth.example.com/" },
      `${HTTP_ENV.issuer} must use https`,
    ],
    [
      { ...remote, [HTTP_ENV.jwksUrl]: "http://auth.example.com/jwks" },
      `${HTTP_ENV.jwksUrl} must use https`,
    ],
    [
      { [HTTP_ENV.issuer]: "https://auth.example.com/", [HTTP_ENV.allowedSubjects]: "u" },
      "is required with OAuth (it is the token audience)",
    ],
    [{ [HTTP_ENV.port]: "70000" }, "must be a port number"],
    [{ [HTTP_ENV.rateLimit]: "0" }, "must be 1 to 10000"],
  ])("reports %j", (env, message) => {
    expect(problems(env)).toContain(message);
  });

  it("allows http for localhost URLs and issuers", () => {
    const c = loadHttpConfig({
      [HTTP_ENV.publicUrl]: "http://localhost:8080/mcp",
      [HTTP_ENV.issuer]: "http://127.0.0.1:9000/",
      [HTTP_ENV.jwksUrl]: "http://localhost:9000/jwks",
      [HTTP_ENV.allowedSubjects]: "me",
    });
    expect(c.oauth?.issuer.href).toBe("http://127.0.0.1:9000/");
  });

  it("ignores an invalid issuer URL after reporting it", () => {
    expect(problems({ ...remote, [HTTP_ENV.issuer]: "::" })).toContain(
      `${HTTP_ENV.issuer} is not a valid URL`,
    );
  });
});

describe("isLoopback", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["192.168.1.2", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});
