// Error messages are written for the AI model: they must name the right source and give a remedy
// that applies (issue #43).
import { describe, expect, it } from "vitest";
import { apiErrors, xmlErrors } from "../../src/api/errors.js";

describe("xmlErrors (the text download from the website)", () => {
  const all = [
    xmlErrors.notFound("act_public_1976_33_en_2014-01-01"),
    xmlErrors.unexpectedRedirect(302),
    xmlErrors.unavailable(503),
    xmlErrors.unexpectedStatus(500),
    xmlErrors.unreadable(),
    xmlErrors.tooLarge(64 * 1024 * 1024),
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
    expect(xmlErrors.notFound("v1").message).toContain("use list_versions to pick another version");
    expect(xmlErrors.tooLarge(64 * 1024 * 1024).message).toContain("64 MB safety limit");
    expect(xmlErrors.tooLarge(64 * 1024 * 1024).message).toContain(
      "Read it on legislation.govt.nz",
    );
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
