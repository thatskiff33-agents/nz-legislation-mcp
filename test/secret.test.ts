import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret } from "../src/secret.js";

const RAW = "k3y-Value-0123456789abcdef";

describe("Secret", () => {
  const secret = new Secret(RAW);

  it("reveals only on explicit request", () => {
    expect(secret.reveal()).toBe(RAW);
  });

  it.each([
    ["String()", () => String(secret)],
    ["toString", () => secret.toString()],
    ["JSON.stringify", () => JSON.stringify({ secret })],
    ["util.inspect", () => inspect(secret, { showHidden: true, depth: 5 })],
    ["util.inspect nested", () => inspect({ config: { apiKey: secret } })],
    ["Object.keys/values", () => JSON.stringify([Object.keys(secret), Object.values(secret)])],
  ])("never exposes the value via %s", (_label, render) => {
    expect(render()).not.toContain(RAW);
  });

  it("redacts every occurrence from text", () => {
    expect(secret.redact(`a ${RAW} b ${RAW}`)).toBe("a [REDACTED] b [REDACTED]");
  });

  it("leaves text unchanged when the secret is empty", () => {
    expect(new Secret("").redact("anything")).toBe("anything");
  });
});
