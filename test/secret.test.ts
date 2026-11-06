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

  it("redacts the URL-encoded form too", () => {
    const s = new Secret("a+b/c=d");
    expect(s.redact("x?api_key=a%2Bb%2Fc%3Dd&y")).toBe("x?api_key=[REDACTED]&y");
  });

  // Characters that encodeURIComponent leaves alone but form encoding escapes, plus a space
  // (+ in a form body, %20 in a URL query).
  const awkward = "ab~c!d(e)f*g'h i+j";

  it.each([
    ["raw", awkward],
    ["encodeURIComponent", encodeURIComponent(awkward)],
    ["form-encoded", new URLSearchParams({ api_key: awkward }).toString()],
    [
      "WHATWG URL query",
      (() => {
        const url = new URL("https://api.example.test/v0/works/");
        url.search = `api_key=${awkward}`;
        return url.href;
      })(),
    ],
  ])("redacts the %s form of a key with awkward characters", (_form, text) => {
    const out = new Secret(awkward).redact(`before ${text} after`);
    expect(out).toContain("[REDACTED]");
    for (const fragment of ["ab~c", "ab%7Ec", "d(e)f", "d%28e%29f", "i+j", "i%2Bj"]) {
      expect(out).not.toContain(fragment);
    }
  });

  it("leaves text unchanged when the secret is empty", () => {
    expect(new Secret("").redact("anything")).toBe("anything");
  });
});
