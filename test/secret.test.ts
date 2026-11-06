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

  // A key validateKey accepts (printable ASCII, no space, quote or backslash), using characters
  // each encoding treats differently.
  const awkward = "ab~c!d(e)f*g+h/i<j&k=l?m#n";
  const whatwgQuery = (() => {
    const url = new URL("https://api.example.test/v0/works/");
    url.search = `k=${awkward}`;
    return url.search.slice(3);
  })();

  it.each([
    ["raw", awkward],
    ["encodeURIComponent", encodeURIComponent(awkward)],
    ["lower-case percent", encodeURIComponent(awkward).toLowerCase()],
    ["encodeURI", encodeURI(awkward)],
    ["double-encoded", encodeURIComponent(encodeURIComponent(awkward))],
    ["form-encoded", new URLSearchParams({ k: awkward }).toString().slice(2)],
    ["WHATWG URL query", whatwgQuery],
    ["JSON with escaped slashes", awkward.replaceAll("/", "\\/")],
    [
      "Go-style JSON",
      awkward.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"),
    ],
  ])("redacts the %s form of a key with awkward characters", (_form, encoded) => {
    expect(new Secret(awkward).redact(`before ${encoded} after`)).toBe("before [REDACTED] after");
  });

  it("redacts a key inside a full URL", () => {
    const url = new URL("https://api.example.test/v0/works/");
    url.searchParams.set("api_key", awkward);
    expect(new Secret(awkward).redact(url.href)).toBe(
      "https://api.example.test/v0/works/?api_key=[REDACTED]",
    );
  });

  it("leaves text unchanged when the secret is empty", () => {
    expect(new Secret("").redact("anything")).toBe("anything");
  });
});
