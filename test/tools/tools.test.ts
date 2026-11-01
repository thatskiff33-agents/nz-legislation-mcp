import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { getApiQuota } from "../../src/tools/get-api-quota.js";
import { getLegislation } from "../../src/tools/get-legislation.js";
import { listVersions } from "../../src/tools/list-versions.js";
import { searchLegislation } from "../../src/tools/search-legislation.js";
import {
  classificationFrom,
  isProvisional,
  linksFrom,
  permalink,
  todayInNewZealand,
  ToolInputError,
  versionDate,
} from "../../src/tools/shared.js";
import { fixture } from "../fixtures.js";
import { json, status } from "../api/fake-fetch.js";
import { deps, signal, versionsPage } from "./harness.js";

const WORK = "act_public_2007_97";

describe("search_legislation", () => {
  it("returns flattened, schema-valid results with notes", async () => {
    const { deps: d, fake } = deps([json(fixture("search-works"))]);
    const args = searchLegislation.inputSchema.parse({ search_term: "income tax", per_page: 3 });
    const out = await searchLegislation.run(args, d, signal);
    expect(searchLegislation.outputSchema.parse(out)).toEqual(out);
    expect(out.total).toBe(241);
    expect(out.has_more).toBe(true);
    expect(out.results[0]).toMatchObject({
      work_id: "act_public_1914_3",
      title: "Land-tax and Income-tax Act 1914",
      version_date: "1914-07-31",
      legislation_type: "act",
      type_status: "repealed",
      category: "public",
      classification: "principal",
      agency_pilot_record: false,
      provisional_id: false,
      permalink: "https://www.legislation.govt.nz/act/public/1914/3/en/1914-07-31/",
    });
    expect(out.results[0]?.links.xml).toBe(
      "https://www.legislation.govt.nz/act/public/1914/3/en/latest.xml",
    );
    expect(out.notes).toHaveLength(1);
    expect(fake.calls[0]?.url).toContain("search_term=income+tax");
  });

  it("treats a missing is_latest_version as unknown", async () => {
    const body = structuredClone(fixture("search-works")) as {
      results: { latest_matching_version: Record<string, unknown> }[];
    };
    for (const r of body.results) delete r.latest_matching_version["is_latest_version"];
    const { deps: d } = deps([json(body)]);
    const out = await searchLegislation.run(searchLegislation.inputSchema.parse({}), d, signal);
    expect(out.results[0]?.is_latest_version).toBeNull();
  });

  it("flags agency pilot records and provisional identifiers", async () => {
    const { deps: d } = deps([json(fixture("search-secondary-agency"))]);
    const out = await searchLegislation.run(
      searchLegislation.inputSchema.parse({ legislation_type: "secondary_legislation" }),
      d,
      signal,
    );
    expect(out.results.every((r) => r.agency_pilot_record && r.provisional_id)).toBe(true);
    expect(out.results[0]?.permalink).toBeNull();
    expect(out.notes.join(" ")).toContain("pilot service");
  });
});

describe("list_versions", () => {
  it("returns versions with dates and permalinks", async () => {
    const { deps: d } = deps([json(fixture("work-versions-page1"))]);
    const out = await listVersions.run({ work_id: WORK, per_page: 20 }, d, signal);
    expect(listVersions.outputSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({ work_id: WORK, total: 206, has_more: true });
    expect(out.versions[0]).toMatchObject({
      version_id: "act_public_2007_97_en_2026-09-04",
      version_date: "2026-09-04",
      permalink: "https://www.legislation.govt.nz/act/public/2007/97/en/2026-09-04/",
    });
  });
});

describe("get_legislation", () => {
  it("gets a specific version by version_id", async () => {
    const { deps: d } = deps([json(fixture("version-historical"))]);
    const out = await getLegislation.run(
      { version_id: "act_public_2007_97_en_2010-04-01" },
      d,
      signal,
    );
    expect(getLegislation.outputSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      version_date: "2010-04-01",
      as_at: null,
      is_latest_version: null,
      newer_versions_exist: null,
    });
  });

  it("flags an agency pilot record fetched by version_id", async () => {
    const id = "secondary-legislation_agency-drafted_2026_~346217_en_2026-10-20";
    const { deps: d } = deps([
      json({
        work_id: "secondary-legislation_agency-drafted_2026_~346217",
        version_id: id,
        title: "Example Code 2026",
        publisher: "Agency",
        legislation_type: "secondary_legislation",
        formats: [{ type: "pdf", url: "https://www.agency.example/code.pdf" }],
      }),
    ]);
    const out = await getLegislation.run({ version_id: id }, d, signal);
    expect(out).toMatchObject({ agency_pilot_record: true, provisional_id: true, permalink: null });
    expect(out.links.pdf).toBe("https://www.agency.example/code.pdf");
    expect(out.notes.join(" ")).toContain("pilot service");
  });

  it("defaults as_at to today in NZ and reports newer (future) versions", async () => {
    const { deps: d } = deps([
      json(versionsPage(WORK, ["2027-04-01", "2026-09-04", "2026-07-10"])),
    ]);
    const out = await getLegislation.run({ work_id: WORK }, d, signal);
    expect(out).toMatchObject({
      version_id: `${WORK}_en_2026-09-04`,
      as_at: "2026-11-02",
      is_latest_version: false,
      newer_versions_exist: true,
    });
    expect(out.notes.join(" ")).toContain("as_at defaulted to today");
    expect(out.notes.join(" ")).toContain("Newer versions exist");
  });

  it("returns the latest version when it is in force on as_at", async () => {
    const { deps: d } = deps([json(versionsPage(WORK, ["2026-09-04", "2026-07-10"]))]);
    const out = await getLegislation.run({ work_id: WORK, as_at: "2026-10-01" }, d, signal);
    expect(out).toMatchObject({ is_latest_version: true, newer_versions_exist: false });
    expect(out.notes).toHaveLength(1);
  });

  it("pages back through history to find an old as_at", async () => {
    const page1 = versionsPage(
      WORK,
      Array.from({ length: 100 }, () => "2020-01-01"),
      150,
      1,
    );
    const page2 = versionsPage(WORK, ["2012-04-01", "2009-04-01"], 150, 2);
    const { deps: d, fake } = deps([json(page1), json(page2)]);
    const out = await getLegislation.run({ work_id: WORK, as_at: "2010-04-01" }, d, signal);
    expect(out.version_id).toBe(`${WORK}_en_2009-04-01`);
    expect(fake.calls[1]?.url).toContain("page=2");
  });

  it("explains when as_at is before the earliest version", async () => {
    const { deps: d } = deps([json(versionsPage(WORK, ["2008-04-01", "2007-11-01"]))]);
    await expect(
      getLegislation.run({ work_id: WORK, as_at: "1999-01-01" }, d, signal),
    ).rejects.toThrow(
      `No version of ${WORK} is dated on or before 1999-01-01. The earliest version found is ${WORK}_en_2007-11-01`,
    );
  });

  it("reports a work with no versions", async () => {
    const { deps: d } = deps([json({ page: 1, per_page: 100, total: 0, results: [] })]);
    await expect(getLegislation.run({ work_id: WORK }, d, signal)).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });

  it("stops at the history page limit", async () => {
    const pages = Array.from({ length: 20 }, (_, i) =>
      json(
        versionsPage(
          WORK,
          Array.from({ length: 100 }, () => "2025-01-01"),
          99_999,
          i + 1,
        ),
      ),
    );
    const { deps: d, fake } = deps(pages);
    await expect(
      getLegislation.run({ work_id: WORK, as_at: "2000-01-01" }, d, signal),
    ).rejects.toThrow("No version");
    expect(fake.calls).toHaveLength(20);
  });

  it("refuses a direct call without an identifier", async () => {
    const { deps: d } = deps([]);
    await expect(getLegislation.run({}, d, signal)).rejects.toThrow(
      "exactly one of work_id or version_id",
    );
  });

  it.each([
    [{}, "exactly one"],
    [{ work_id: WORK, version_id: `${WORK}_en_2010-04-01` }, "exactly one"],
    [{ version_id: `${WORK}_en_2010-04-01`, as_at: "2020-01-01" }, "as_at only applies"],
    [{ work_id: WORK, as_at: "2020-02-30" }, "Invalid"],
  ])("validates input %j", (input, message) => {
    const r = getLegislation.inputSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join(" ")).toContain(message);
  });

  it("propagates API errors", async () => {
    const { deps: d } = deps([status(404)]);
    await expect(
      getLegislation.run({ version_id: `${WORK}_en_1900-01-01` }, d, signal),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("get_api_quota", () => {
  it("reports unknown before any call, and figures after", async () => {
    const { deps: d } = deps([json(fixture("version-latest"))]);
    const before = await getApiQuota.run({}, d, signal);
    expect(getApiQuota.outputSchema.parse(before)).toEqual(before);
    expect(before.known).toBe(false);
    await d.client.getVersion(`${WORK}_en_2026-09-04`);
    const after = await getApiQuota.run({}, d, signal);
    expect(after).toMatchObject({
      known: true,
      daily_limit: 10000,
      remaining: 9876,
      resets_at: new Date(1793617200 * 1000).toISOString(),
    });
  });
});

describe("shared helpers", () => {
  it("keeps the first link per known format and ignores unknown types", () => {
    expect(
      linksFrom([
        { type: "html", url: "https://a/1" },
        { type: "html", url: "https://a/2" },
        { type: "epub", url: "https://a/3" },
      ]),
    ).toEqual({ html: "https://a/1" });
  });

  it("flattens classification for bills and instruments", () => {
    expect(
      classificationFrom({ legislation_type: "bill", bill_type: "member", bill_status: "current" }),
    ).toMatchObject({ category: "member", type_status: "current", administering_agencies: [] });
    expect(
      classificationFrom({
        instrument_type_group: "regulations",
        instrument_status: "in_force",
        instrument_classification: "amendment",
      }),
    ).toMatchObject({
      category: "regulations",
      type_status: "in_force",
      classification: "amendment",
    });
  });

  it("handles unparseable version ids", () => {
    expect(versionDate("nonsense")).toBeNull();
    expect(permalink("nonsense")).toBeNull();
    expect(isProvisional("nonsense")).toBe(false);
  });

  it("computes today in New Zealand across the date line", () => {
    // 2026-11-02T12:30Z is 2026-11-03 01:30 in NZ (NZDT, UTC+13).
    expect(todayInNewZealand(new Date("2026-11-02T12:30:00Z"))).toBe("2026-11-03");
    expect(typeof todayInNewZealand()).toBe("string");
  });
});
