import { describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
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
import { fixture } from "../fixtures.js";

describe("identifier schemas", () => {
  it("accepts and trims valid identifiers", () => {
    expect(WorkIdSchema.parse(" act_public_2007_97 ")).toBe("act_public_2007_97");
    expect(VersionIdSchema.parse("act_public_2007_97_en_2025-05-29B")).toBe(
      "act_public_2007_97_en_2025-05-29B",
    );
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

  it.each(["error-401", "error-404"])("error body %s", (name) => {
    expect(ApiErrorBodySchema.safeParse(fixture(name)).success).toBe(true);
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

  it("rejects non-https format links", () => {
    expect(FormatSchema.safeParse({ type: "pdf", url: "http://example.com/x.pdf" }).success).toBe(
      false,
    );
    expect(FormatSchema.safeParse({ type: "pdf", url: "javascript:alert(1)" }).success).toBe(false);
  });
});
