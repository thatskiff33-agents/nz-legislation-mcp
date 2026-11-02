import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { normaliseLabel, readLegislation } from "../../src/text/document.js";
import { chunked, loadXml } from "./xml.js";

const WAITANGI = loadXml("waitangi-day-act-1976.xml");
const ITA = loadXml("income-tax-act-2007-parts-a-b.xml");
const SYNTH = loadXml("synthetic-structures.xml");

describe("outline", () => {
  it("reads title, sections and an unnumbered schedule (real Act)", async () => {
    const doc = await readLegislation(chunked(WAITANGI), { fullOutline: true });
    expect(doc.title).toBe("Waitangi Day Act 1976");
    expect(doc.outline.map((e) => `${e.kind}:${e.label}`)).toEqual([
      "section:1",
      "section:2",
      "section:3",
      "section:4",
      "section:5",
      "section:6",
      "section:6A",
      "section:7",
      "schedule:",
    ]);
    expect(doc.outline.at(-1)?.heading).toBe("The Treaty of Waitangi");
    expect(doc.text).toBeNull();
  });

  it("nests parts and subparts (real Income Tax Act slice)", async () => {
    const doc = await readLegislation(chunked(ITA), { fullOutline: true });
    const bb2 = doc.outline.find((e) => e.label === "BB 2");
    expect(bb2).toMatchObject({
      kind: "section",
      heading: "Main obligations",
      depth: 2,
      within: ["B", "BB"],
    });
    expect(doc.outline.find((e) => e.label === "BB")).toMatchObject({
      kind: "subpart",
      depth: 1,
      within: ["B"],
    });
    expect(doc.outline[0]).toMatchObject({ kind: "part", label: "A", depth: 0, within: [] });
  });

  it("records body cross-headings and schedule context", async () => {
    const doc = await readLegislation(chunked(SYNTH), { fullOutline: true });
    expect(doc.outline[0]).toMatchObject({ kind: "crosshead", heading: "Preliminary provisions" });
    const clause = doc.outline.find((e) => e.kind === "section" && e.schedule === "1");
    expect(clause).toMatchObject({ label: "1", heading: "Application" });
  });
});

describe("rendering", () => {
  it("renders a section with subsection labels and cross-headings (real)", async () => {
    const doc = await readLegislation(chunked(ITA), { target: { section: "BB 2" } });
    expect(doc.found?.label).toBe("BB 2");
    expect(doc.text?.split("\n").slice(0, 3)).toEqual([
      "BB 2 Main obligations",
      "Income tax liability",
      "(1) A person's income tax liability for a tax year must be calculated, and satisfied by the person, under subpart BC (Calculating and satisfying income tax liabilities).",
    ]);
  });

  it("matches labels loosely (case, spacing, 's' prefix)", async () => {
    for (const label of ["bb 2", "BB  2", "s BB 2", "section BB 2"]) {
      const doc = await readLegislation(chunked(ITA), { target: { section: label } });
      expect(doc.found?.label).toBe("BB 2");
    }
  });

  it("indents nested paragraphs and definitions", async () => {
    const doc = await readLegislation(chunked(SYNTH), { target: { section: "1" } });
    expect(doc.text).toBe(
      [
        "1 Interpretation",
        "(1) In this Act, unless the context otherwise requires,—",
        "  employer means a person who—",
        "    (a) employs another person; or",
        "      (i) engages a contractor",
        "    (b) is treated as an employer.",
      ].join("\n"),
    );
  });

  it("includes amendment history only on request", async () => {
    const withHistory = await readLegislation(chunked(SYNTH), {
      target: { section: "1" },
      includeHistory: true,
    });
    expect(withHistory.text).toContain(
      "[History] amended on 1 April 2100 by section 3 of the Example Amendment Act 2100",
    );
    expect(withHistory.text).not.toContain("Compare: old section 1"); // editorial aids never
  });

  it("renders tables as rows, line breaks and graphics", async () => {
    const doc = await readLegislation(chunked(SYNTH), { target: { section: "2" } });
    expect(doc.text).toBe(
      [
        "2 Rates table",
        "The rates are:",
        "| Band | Rate |",
        "| 0 to 14,000 | 10.5% |",
        "First line",
        "second line [graphic omitted]",
      ].join("\n"),
    );
  });

  it("finds a clause inside a schedule, and a whole schedule", async () => {
    const clause = await readLegislation(chunked(SYNTH), {
      target: { section: "1", schedule: "1" },
    });
    expect(clause.text).toBe("1 Application\nThis clause applies from 2099.");
    const schedule = await readLegislation(chunked(SYNTH), { target: { schedule: "Schedule 1" } });
    expect(schedule.text).toBe(
      "1 Transitional provisions\n1 Application\nThis clause applies from 2099.",
    );
    const unnumbered = await readLegislation(chunked(WAITANGI), { target: { schedule: "" } });
    expect(unnumbered.text?.startsWith("The Treaty of Waitangi\nHER MAJESTY VICTORIA")).toBe(true);
  });

  it("does not confuse a body section with a schedule clause of the same number", async () => {
    const body = await readLegislation(chunked(SYNTH), { target: { section: "1" } });
    expect(body.found?.schedule).toBeNull();
    expect(body.text?.startsWith("1 Interpretation")).toBe(true);
  });

  it("stops reading once the target is complete", async () => {
    let chunksRead = 0;
    async function* counting(): AsyncGenerator<string> {
      for await (const c of chunked(ITA, 500)) {
        chunksRead += 1;
        yield c;
      }
    }
    await readLegislation(counting(), { target: { section: "AA 1" } });
    expect(chunksRead).toBeLessThan(Math.ceil(ITA.length / 500) / 2);
  });

  it("returns null text (with the full outline) when the target is missing", async () => {
    const doc = await readLegislation(chunked(WAITANGI), { target: { section: "99" } });
    expect(doc.text).toBeNull();
    expect(doc.found).toBeNull();
    expect(doc.outline).toHaveLength(9);
  });

  it("truncates a pathologically long provision", async () => {
    const huge = "x ".repeat(1_100_000);
    const xml = `<act><body><prov><label>1</label><heading>Big</heading><prov.body><subprov><label/><para><text>${huge}</text></para><para><text>${huge}</text></para></subprov></prov.body></prov></body></act>`;
    const doc = await readLegislation(chunked(xml, 65536), { target: { section: "1" } });
    expect(
      doc.text?.endsWith("[Text truncated: this provision exceeds the rendering limit.]"),
    ).toBe(true);
  });
});

describe("safety", () => {
  it("rejects malformed XML", async () => {
    await expect(readLegislation(chunked("<act><body><prov></act>"))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("does not expand internal entities (billion laughs)", async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE act [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label/><para><text>&b;&b;&b;</text></para></subprov></prov.body></prov></body></act>`;
    const result = await readLegislation(chunked(bomb), { target: { section: "1" } }).then(
      (r) => r.text,
      (e: unknown) => e,
    );
    // Either a parse error, or the entity left unexpanded: never "aaaa..." repeated.
    if (typeof result === "string") expect(result).not.toContain("aaaaaaaaaa");
    else expect(result).toBeInstanceOf(ApiError);
  });

  it("does not resolve external entities", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE act [<!ENTITY x SYSTEM "file:///etc/passwd">]><act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label/><para><text>&x;</text></para></subprov></prov.body></prov></body></act>`;
    const result = await readLegislation(chunked(xxe), { target: { section: "1" } }).then(
      (r) => r.text,
      (e: unknown) => e,
    );
    if (typeof result === "string") expect(result).not.toContain("root:");
    else expect(result).toBeInstanceOf(ApiError);
  });

  it("never emits control characters", async () => {
    // &#x1; is not allowed in XML 1.0 (sax leaves it as literal text); &#x7F; and &#x85; are.
    const xml =
      "<act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label/><para><text>a&#x7F;b&#x85;c&#x1;d</text></para></subprov></prov.body></prov></body></act>";
    const doc = await readLegislation(chunked(xml), { target: { section: "1" } });
    // eslint-disable-next-line no-control-regex -- checking for control characters
    expect(doc.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);
    expect(doc.text?.startsWith("1 H\nabc")).toBe(true);
  });

  it("starts a new line for each further paragraph in a subsection", async () => {
    const xml =
      "<act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label>1</label><para><text>First.</text></para><para><text>Second.</text></para></subprov></prov.body></prov></body></act>";
    const doc = await readLegislation(chunked(xml), { target: { section: "1" } });
    expect(doc.text).toBe("1 H\n(1) First.\nSecond.");
  });
});

describe("normaliseLabel", () => {
  it.each([
    ["CA 1", "ca 1"],
    ["  s 13 ", "13"],
    ["section 6A", "6a"],
    ["Schedule 1", "1"],
    ["cl. 2", "2"],
    ["ss 3", "3"],
  ])("%j -> %j", (input, expected) => {
    expect(normaliseLabel(input)).toBe(expected);
  });
});
