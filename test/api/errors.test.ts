// Error messages are written for the AI model: they must name the right source and give a remedy
// that applies (issue #43).
import { describe, expect, it } from "vitest";
import { apiErrors, xmlErrors } from "../../src/api/errors.js";

describe("xmlErrors (the text download from the website)", () => {
  const PAGE = "https://www.legislation.govt.nz/act/public/1976/33/en/2014-01-01/";
  const all = [
    xmlErrors.notFound("act_public_1976_33_en_2014-01-01", PAGE),
    xmlErrors.unexpectedRedirect(302),
    xmlErrors.unavailable(503),
    xmlErrors.unexpectedStatus(500),
    xmlErrors.unreadable(),
    xmlErrors.tooLarge(64 * 1024 * 1024, PAGE),
    xmlErrors.timeout(30_000),
    xmlErrors.network(),
  ];

  it("keeps the same kinds and retry advice as the API errors", () => {
    expect(all.map((e) => [e.kind, e.retryable])).toEqual([
      ["not_found", false],
      ["unexpected_redirect", false],
      ["upstream_unavailable", true],
      ["upstream_error", false],
      ["invalid_response", false],
      ["response_too_large", false],
      ["timeout", true],
      ["network", true],
    ]);
  });

  it("blames the website, never the API, and gives no paging advice", () => {
    for (const error of all) {
      expect(error.message, error.kind).not.toMatch(/Legislation API|API \(v0\)|per page|narrow/u);
      expect(error.message, error.kind).toMatch(/legislation\.govt\.nz/u);
    }
  });

  it("says what to do for a missing or oversized text", () => {
    expect(xmlErrors.notFound("v1", PAGE).message).toContain(
      "use list_versions to pick another version",
    );
    expect(xmlErrors.tooLarge(64 * 1024 * 1024, PAGE).message).toContain("64 MB safety limit");
    expect(xmlErrors.tooLarge(64 * 1024 * 1024, PAGE).message).toContain(
      `otherwise read it on the official page: ${PAGE}`,
    );
    expect(xmlErrors.notFound("v1", PAGE).message).toContain(PAGE);
  });
});

describe("malformed XML", () => {
  it("is reported as unreadable text from the website", async () => {
    const { readLegislation } = await import("../../src/text/document.js");
    const { chunked } = await import("../text/xml.js");
    const error = await readLegislation(chunked("<act><body><prov></act>")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect((error as Error).message).toContain("www.legislation.govt.nz");
    expect((error as Error).message).not.toContain("Legislation API");
  });
});

describe("apiErrors.unauthorised", () => {
  it("lists every place the key can come from and points to doctor", () => {
    const { message } = apiErrors.unauthorised();
    for (const source of [
      "LEGISLATION_NZ_API_KEY,",
      "LEGISLATION_NZ_API_KEY_FILE",
      "nz-legislation-mcp setup",
      "Claude Code plugin",
      "operator's key",
      "npx nz-legislation-mcp doctor",
    ]) {
      expect(message).toContain(source);
    }
  });
});
