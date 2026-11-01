import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatVersionId,
  formatWorkId,
  MAX_ID_LENGTH,
  parseVersionId,
  parseWorkId,
  websiteUrl,
  type VersionId,
} from "../../src/domain/ids.js";
import { ID_SUBTYPES } from "../../src/domain/vocabulary.js";
import { allFixtureIds, fixture } from "../fixtures.js";

function mustParseVersion(id: string): VersionId {
  const r = parseVersionId(id);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("identifiers from live API responses", () => {
  const { workIds, versionIds } = allFixtureIds();

  it("has a meaningful sample", () => {
    expect(workIds.length).toBeGreaterThan(40);
    expect(versionIds.length).toBeGreaterThan(80);
  });

  it.each(workIds)("parses and round-trips work_id %s", (id) => {
    const r = parseWorkId(id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(formatWorkId(r.value)).toBe(id);
  });

  it.each(versionIds)("parses and round-trips version_id %s", (id) => {
    expect(formatVersionId(mustParseVersion(id))).toBe(id);
  });
});

describe("parseWorkId", () => {
  it("parses a public Act", () => {
    expect(parseWorkId("act_public_2007_97")).toEqual({
      ok: true,
      value: { type: "act", subtype: "public", year: "2007", number: "97", provisional: false },
    });
  });

  it("marks provisional agency identifiers", () => {
    const r = parseWorkId("secondary-legislation_agency-drafted_~2026_~346285");
    expect(r.ok && r.value.provisional).toBe(true);
    const yearOnly = parseWorkId("secondary-legislation_agency-drafted_2026_~346217");
    expect(yearOnly.ok && yearOnly.value.provisional).toBe(true);
  });

  it("accepts documented number forms such as 96-B", () => {
    expect(parseWorkId("bill_government_2010_96-B").ok).toBe(true);
  });

  it.each([
    ["", "1 to"],
    ["x".repeat(MAX_ID_LENGTH + 1), "1 to"],
    ["act_public_2007", "is not a work_id"],
    ["act_public_2007_97_extra", "is not a work_id"],
    ["statute_public_2007_97", 'Unknown type "statute"'],
    ["bill_member_2025_168", 'Unknown subtype "member"'],
    ["act_public_07_97", "Invalid year"],
    ["act_public_2007_9 7", "Invalid number"],
    ["act_public_2007_../../etc", "Invalid number"],
    ["act_public_2007_97a", "Invalid number"],
    ["act_public_２００７_97", "Invalid year"],
    ["act\npublic_2007_97", "is not a work_id"],
  ])("rejects %j", (input, message) => {
    const r = parseWorkId(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("parseVersionId", () => {
  it("parses same-day suffixes", () => {
    const v = mustParseVersion("act_public_2007_97_en_2025-05-29B");
    expect(v).toMatchObject({
      date: "2025-05-29",
      suffix: "B",
      provisional: false,
      dateProvisional: false,
    });
  });

  it("accepts up to eight same-day suffix letters", () => {
    expect(mustParseVersion("act_public_2007_97_en_2025-05-29ABCDEFGH").suffix).toBe("ABCDEFGH");
  });

  it("quotes untrusted input safely in error messages", () => {
    const r = parseWorkId("evil\nline_public_2007_97");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("\n");
  });

  it("parses a provisional year with a firm number", () => {
    const v = mustParseVersion("secondary-legislation_agency-drafted_~2026_346217_en_2026-10-20");
    expect(v.provisional).toBe(true);
  });

  it("parses a provisional date", () => {
    const v = mustParseVersion("secondary-legislation_agency-drafted_~2026_~346285_en_~2026-10-30");
    expect(v).toMatchObject({ dateProvisional: true, provisional: true });
  });

  it("treats a provisional work with a firm date as provisional", () => {
    const v = mustParseVersion("secondary-legislation_agency-drafted_2026_~346217_en_2026-10-20");
    expect(v).toMatchObject({ dateProvisional: false, provisional: true });
  });

  it.each([
    ["", "1 to"],
    ["y".repeat(MAX_ID_LENGTH + 1), "1 to"],
    ["act_public_2007_97", "is not a version_id"],
    ["act_publik_2007_97_en_2025-05-29", "Unknown subtype"],
    ["act_public_2007_97_mi_2025-05-29", 'Unsupported language "mi"'],
    ["act_public_2007_97_en_29-05-2025", "Invalid version date"],
    ["act_public_2007_97_en_2025-02-30", "not a real calendar date"],
    ["act_public_2007_97_en_2025-13-01", "not a real calendar date"],
    ["act_public_2007_97_en_2025-05-29ABCDEFGHI", "Invalid version date"],
    ["act_public_2007_97_en_2025-05-29b", "Invalid version date"],
  ])("rejects %j", (input, message) => {
    const r = parseVersionId(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("property-based", () => {
  const segment = (re: string) => fc.stringMatching(new RegExp(`^${re}$`));
  const workArb = fc
    .constantFrom(...(Object.keys(ID_SUBTYPES) as (keyof typeof ID_SUBTYPES)[]))
    .chain((type) =>
      fc.record({
        type: fc.constant(type),
        subtype: fc.constantFrom(...ID_SUBTYPES[type]),
        year: segment("~?[0-9]{4}"),
        number: segment("~?[0-9]{1,7}[A-Z]?(-[A-Z0-9]{1,4})?"),
      }),
    );
  const dateArb = fc
    .date({ min: new Date("1840-01-01"), max: new Date("2100-12-31"), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10));

  it("round-trips every well-formed version_id", () => {
    fc.assert(
      fc.property(
        workArb,
        dateArb,
        fc.boolean(),
        segment("[A-Z]{0,8}"),
        (w, date, tilde, suffix) => {
          const id = `${w.type}_${w.subtype}_${w.year}_${w.number}_en_${tilde ? "~" : ""}${date}${suffix}`;
          expect(formatVersionId(mustParseVersion(id))).toBe(id);
        },
      ),
    );
  });

  it("never throws, whatever the input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(() => parseWorkId(s)).not.toThrow();
        expect(() => parseVersionId(s)).not.toThrow();
      }),
    );
  });

  it("only accepts a safe URL character set, even from hostile near-miss inputs", () => {
    // Mutate valid IDs with characters that matter for URLs and lookalike attacks.
    const hostile = fc.constantFrom(
      "/",
      ".",
      "%",
      "\\",
      "?",
      "#",
      " ",
      "\u2215",
      "２",
      "\u200b",
      "a",
      "~",
      "_",
      "-",
    );
    const valid = fc.constantFrom(...allFixtureIds().versionIds);
    let accepted = 0;
    fc.assert(
      fc.property(valid, fc.nat(80), hostile, (id, at, ch) => {
        const pos = at % (id.length + 1);
        const mutated = id.slice(0, pos) + ch + id.slice(pos);
        const r = parseVersionId(mutated);
        if (r.ok) {
          accepted += 1;
          expect(mutated).toMatch(/^[A-Za-z0-9_~-]+$/);
          expect(formatVersionId(r.value)).toBe(mutated);
        }
      }),
      // Always-run example: appending a suffix letter keeps the ID valid, so the accept path runs.
      { numRuns: 500, examples: [["act_public_2007_97_en_2025-05-29", 31, "A"]] },
    );
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("websiteUrl", () => {
  it("builds dated URLs that match what the API returns for historical versions", () => {
    const record = fixture("version-historical") as {
      version_id: string;
      formats: { type: string; url: string }[];
    };
    const version = mustParseVersion(record.version_id);
    for (const f of record.formats) {
      expect(websiteUrl(version, f.type as "html" | "pdf" | "xml")).toBe(f.url);
    }
  });

  it("keeps same-day suffixes in the URL", () => {
    expect(websiteUrl(mustParseVersion("act_public_2007_97_en_2026-06-06B"), "xml")).toBe(
      "https://www.legislation.govt.nz/act/public/2007/97/en/2026-06-06B.xml",
    );
  });

  it("returns undefined for provisional (agency) identifiers", () => {
    const v = mustParseVersion("secondary-legislation_agency-drafted_~2026_~346285_en_~2026-10-30");
    expect(websiteUrl(v, "pdf")).toBeUndefined();
  });
});
