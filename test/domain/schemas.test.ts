import { describe, expect, it } from "vitest";
import {
  FormatSchema,
  SearchParamsSchema,
  SearchResponseSchema,
  toSearchQuery,
  VersionIdSchema,
  VersionListParamsSchema,
  VersionListResponseSchema,
  VersionRecordSchema,
  WorkIdSchema,
} from "../../src/domain/schemas.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../fixtures.js";

describe("identifier schemas", () => {
  it("accepts and trims valid identifiers", () => {
    expect(WorkIdSchema.parse(" act_public_2007_97 ")).toBe("act_public_2007_97");
    expect(VersionIdSchema.parse("act_public_2007_97_en_2025-05-29B")).toBe(
      "act_public_2007_97_en_2025-05-29B",
    );
  });

  it("reports a single message for an over-long identifier", () => {
    const r = WorkIdSchema.safeParse("x".repeat(200));
    expect(r.error?.issues).toHaveLength(1);
  });

  it("reports the parser's actionable message", () => {
    const r = WorkIdSchema.safeParse("bill_member_2025_168");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('Unknown subtype "member"');
    expect(VersionIdSchema.safeParse("act_public_2007_97").success).toBe(false);
  });
});

describe("SearchParamsSchema", () => {
  it("accepts a typical search", () => {
    const p = SearchParamsSchema.parse({
      search_term: ' "fringe benefit" ',
      search_field: "content",
      legislation_type: "act",
      act_status: "in_force",
      per_page: 10,
    });
    expect(p.search_term).toBe('"fringe benefit"');
  });

  it("allows browsing by filters alone", () => {
    expect(
      SearchParamsSchema.parse({ legislation_type: "bill", bill_status: "current" }),
    ).toBeTruthy();
  });

  it.each([
    [{ act_status: "in_force" }, 'act_status only applies when legislation_type is "act"'],
    [{ legislation_type: "bill", act_type: "public" }, "act_type only applies"],
    [{ legislation_type: "act", instrument_status: "revoked" }, "instrument_status only applies"],
    [{ legislation_type: "amendment_paper", bill_type: "member" }, "bill_type only applies"],
  ])("rejects mismatched type-specific filter %j", (input, message) => {
    const r = SearchParamsSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join(" ")).toContain(message);
  });

  it.each([
    [{ legislation_type: "act", publisher: "Agency" }, true],
    [{ legislation_type: "bill", publisher: "Agency" }, true],
    [{ legislation_type: "secondary_legislation", publisher: "Agency" }, false],
    [{ publisher: "Agency" }, false],
    [{ legislation_type: "act", publisher: "Parliamentary Counsel Office" }, false],
  ])("publisher rule for %j (rejected: %s)", (input, rejected) => {
    const r = SearchParamsSchema.safeParse(input);
    expect(r.success).toBe(!rejected);
    if (rejected) expect(r.error?.issues[0]?.message).toContain('publisher "Agency" only applies');
  });

  it("keeps the default message for a non-object input", () => {
    const r = SearchParamsSchema.safeParse("tax");
    expect(r.error?.issues[0]?.message).toContain("expected object");
  });

  it("lists allowed parameters when an unknown one is given", () => {
    const r = SearchParamsSchema.safeParse({ query: "tax" });
    expect(r.error?.issues[0]?.message).toMatch(
      /Unknown parameter\(s\): query\. Allowed parameters: search_term, /,
    );
  });

  it.each([
    { search_term: "tax\u0000" },
    { search_term: "tax\nlevy" },
    { administering_agency: "Inland Revenue\u0007" },
  ])("rejects control characters in %j", (input) => {
    expect(SearchParamsSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { legislation_type: "nonsense" },
    { per_page: 101 },
    { page: 0 },
    { page: 1.5 },
    { search_term: "x".repeat(501) },
    { search_term: "   " },
    { unexpected: true },
  ])("rejects invalid input %j", (input) => {
    expect(SearchParamsSchema.safeParse(input).success).toBe(false);
  });
});

describe("toSearchQuery", () => {
  it("maps our names to API query parameters and skips undefined", () => {
    const q = toSearchQuery(
      SearchParamsSchema.parse({
        search_term: "tax",
        administering_agency: "Inland Revenue Department",
        page: 2,
      }),
    );
    expect(q.toString()).toBe(
      "search_term=tax&administering_agencies=Inland+Revenue+Department&page=2",
    );
  });

  it("ignores keys explicitly set to undefined", () => {
    expect(toSearchQuery({ search_term: undefined, page: 3 }).toString()).toBe("page=3");
  });
});

describe("VersionListParamsSchema", () => {
  it("validates the work id and options", () => {
    expect(VersionListParamsSchema.parse({ work_id: "act_public_2007_97", sort: "asc" })).toEqual({
      work_id: "act_public_2007_97",
      sort: "asc",
    });
    expect(VersionListParamsSchema.safeParse({ work_id: "nope" }).success).toBe(false);
  });
});

describe("response schemas parse every recorded response", () => {
  it.each([
    "search-works",
    "search-bills",
    "search-amendment-papers",
    "search-secondary-pco",
    "search-secondary-agency",
    "search-invalid-filter-empty",
  ])("search fixture %s", (name) => {
    expect(SearchResponseSchema.safeParse(fixture(name)).success).toBe(true);
  });

  it("versions list", () => {
    const r = VersionListResponseSchema.parse(fixture("work-versions-page1"));
    expect(r.total).toBe(206);
  });

  it.each(["version-latest", "version-historical"])("version record %s", (name) => {
    expect(VersionRecordSchema.safeParse(fixture(name)).success).toBe(true);
  });

  it("strips unknown fields and tolerates new enum values (tolerant reader)", () => {
    const r = VersionRecordSchema.parse({
      work_id: "act_public_2007_97",
      version_id: "act_public_2007_97_en_2026-09-04",
      title: "Income Tax Act 2007",
      legislation_status: "some_future_status",
      brand_new_field: 1,
    });
    expect(r.legislation_status).toBe("some_future_status");
    expect(r).not.toHaveProperty("brand_new_field");
  });

  it("drops one bad format link instead of failing the whole response", () => {
    const body = structuredClone(fixture("search-secondary-agency")) as {
      results: { latest_matching_version: { formats: { type: string; url: string }[] } }[];
    };
    const withLinks = body.results.find((r) => r.latest_matching_version.formats.length > 0);
    if (withLinks === undefined) throw new Error("fixture has no linked records");
    const before = withLinks.latest_matching_version.formats.length;
    withLinks.latest_matching_version.formats.push(
      { type: "pdf", url: "http://insecure.example/x.pdf" },
      { type: "pdf", url: "https://user:pw@evil.example/x.pdf" },
      { type: "pdf" } as unknown as { type: string; url: string },
    );
    const parsed = SearchResponseSchema.parse(body);
    const record = parsed.results.find(
      (r) => r.work_id === (withLinks as unknown as { work_id: string }).work_id,
    );
    expect(record?.latest_matching_version.formats).toHaveLength(before);
  });

  it("treats a missing format list as empty", () => {
    const r = VersionRecordSchema.parse({
      work_id: "w",
      version_id: "v",
      title: "t",
      formats: null,
    });
    expect(r.formats).toEqual([]);
  });

  it("rejects non-https format links", () => {
    expect(FormatSchema.safeParse({ type: "pdf", url: "http://example.com/x.pdf" }).success).toBe(
      false,
    );
    expect(FormatSchema.safeParse({ type: "pdf", url: "javascript:alert(1)" }).success).toBe(false);
    expect(FormatSchema.safeParse({ type: "pdf", url: "https://a:b@x.example/y" }).success).toBe(
      false,
    );
    expect(FormatSchema.safeParse({ type: "pdf", url: "https://x.example/y" }).success).toBe(true);
  });
});

describe("search parameters match the API spec", () => {
  it("sends only parameters the /v0/works/ endpoint documents", () => {
    const spec = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "spec", "legislation-api-v0.openapi.json"),
        "utf8",
      ),
    ) as { paths: Record<string, { get: { parameters: { name: string }[] } }> };
    const documented = new Set(spec.paths["/v0/works/"]?.get.parameters.map((p) => p.name));
    const sent = [
      ...toSearchQuery(
        Object.fromEntries(Object.keys(SearchParamsSchema.shape).map((k) => [k, 1])),
      ).keys(),
    ];
    expect(sent.length).toBe(Object.keys(SearchParamsSchema.shape).length);
    for (const name of sent) expect(documented).toContain(name);
  });
});
