// Part and subpart are distinct (issue #41): in modern Acts subpart numbers restart in each part,
// as in the Health and Safety at Work Act 2015 (Part 1 and Part 2 both have Subparts 1 and 2).
import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/api/cache.js";
import { isWithin, readLegislation } from "../../src/text/document.js";
import { compareVersions } from "../../src/tools/compare-versions.js";
import { getProvisionText } from "../../src/tools/get-provision-text.js";
import { getTableOfContents } from "../../src/tools/get-table-of-contents.js";
import { describeEnclosing, ProvisionShape } from "../../src/tools/text-common.js";
import { json } from "../api/fake-fetch.js";
import { chunked, loadXml } from "../text/xml.js";
import { deps, signal } from "./harness.js";

const HSWA = loadXml("health-and-safety-at-work-act-2015-parts-1-2.xml");
const ITA = loadXml("income-tax-act-2007-parts-a-b.xml");
const ID = "act_public_2015_70_en_2025-04-05B";
const record = () =>
  json({ work_id: "act_public_2015_70", version_id: ID, title: "HSWA", formats: [] });
const toc = (args: { part?: string; subpart?: string }) =>
  getTableOfContents.run(
    { version_id: ID, ...args },
    deps([record()], "x", { [ID]: HSWA }).deps,
    signal,
  );

describe("the real Act restarts subpart numbering in each part", () => {
  it("records each enclosing part and subpart with its kind", async () => {
    const doc = await readLegislation(chunked(HSWA), { fullOutline: true });
    const s30 = doc.outline.find((e) => e.kind === "section" && e.label === "30");
    expect(s30?.within).toEqual([
      { kind: "part", label: "2" },
      { kind: "subpart", label: "1" },
    ]);
    const subparts = doc.outline.filter((e) => e.kind === "subpart").map((e) => e.label);
    expect(subparts).toEqual(["1", "2", "1", "2"]);
  });

  it("lists one part's subpart only when both are given", async () => {
    const out = await toc({ part: "2", subpart: "1" });
    expect(out.entries.map((e) => `${e.kind}:${e.label}`)).toEqual(["subpart:1", "section:30"]);
    expect(out.scope).toBe("Everything in part 2 subpart 1.");
  });

  it("does not mix subparts of other parts into a part", async () => {
    const out = await toc({ part: "Part 1" });
    expect(out.entries.map((e) => `${e.kind}:${e.label}`)).toEqual([
      "part:1",
      "subpart:1",
      "section:3",
      "subpart:2",
      "section:5",
    ]);
  });

  it("lists a subpart from every part, with a note, when part is not given", async () => {
    const out = await toc({ subpart: "Subpart 1" });
    expect(out.entries.map((e) => `${e.kind}:${e.label}`)).toEqual([
      "subpart:1",
      "section:3",
      "subpart:1",
      "section:30",
    ]);
    expect(out.notes.join(" ")).toContain(
      "Subpart 1 occurs in Part 1, Part 2; pass part as well to list just one.",
    );
  });

  it("names the top level when a matching subpart is outside any part", async () => {
    const xml =
      "<act><body><subpart><label>1</label><heading>Loose</heading></subpart>" +
      "<part><label>2</label><heading>P</heading><subpart><label>1</label><heading>In P2</heading></subpart></part></body></act>";
    const id = "act_public_2099_9_en_2099-01-01";
    const out = await getTableOfContents.run(
      { version_id: id, subpart: "1" },
      deps([json({ work_id: "act_public_2099_9", version_id: id, title: "T", formats: [] })], "x", {
        [id]: xml,
      }).deps,
      signal,
    );
    expect(out.notes.join(" ")).toContain("Subpart 1 occurs in the top level, Part 2");
  });

  it("finds a section through part and subpart, and not through the wrong part", async () => {
    const text = (args: { part?: string; subpart?: string }) =>
      getProvisionText.run(
        { version_id: ID, section: "30", ...args },
        deps([record()], "x", { [ID]: HSWA }).deps,
        signal,
      );
    const found = await text({ part: "2", subpart: "1" });
    expect(found.provision).toMatchObject({ label: "30", within: ["Part 2", "Subpart 1"] });
    await expect(text({ part: "1", subpart: "1" })).rejects.toThrow("was not found");
  });
});

describe("picking a schedule clause repeated in each part's subpart 1", () => {
  const clause = (word: string) =>
    `<prov><label>1</label><heading>${word}</heading><prov.body><subprov><label/><para><text>${word}</text></para></subprov></prov.body></prov>`;
  const sub = (word: string) =>
    `<subpart><label>1</label><heading>S</heading>${clause(word)}</subpart>`;
  const XML = `<act><body/><schedule.group><schedule><label>1</label><heading>Rates</heading><schedule.provisions><part><label>1</label><heading>P1</heading>${sub("Alpha")}</part><part><label>2</label><heading>P2</heading>${sub("Beta")}</part></schedule.provisions></schedule></schedule.group></act>`;

  it("uses part and subpart together", async () => {
    const pick = (part: string) =>
      readLegislation(chunked(XML), {
        target: { section: "1", schedule: "1", part, subpart: "1" },
      });
    expect((await pick("2")).text).toBe("1 Beta\nBeta");
    expect((await pick("1")).text).toBe("1 Alpha\nAlpha");
  });
});

describe("isWithin", () => {
  const within = [
    { kind: "part" as const, label: "2" },
    { kind: "subpart" as const, label: "1" },
  ];

  it("matches by kind, and a subpart only inside the given part", () => {
    expect(isWithin(within, "2", undefined)).toBe(true);
    expect(isWithin(within, "1", undefined)).toBe(false);
    expect(isWithin(within, undefined, "1")).toBe(true);
    expect(isWithin(within, undefined, "2")).toBe(false);
    expect(isWithin(within, "Part 2", "Subpart 1")).toBe(true);
    expect(isWithin([{ kind: "subpart", label: "1" }], "1", undefined)).toBe(false);
    // A subpart that comes before the part (outside it) does not count.
    expect(
      isWithin(
        [
          { kind: "subpart", label: "1" },
          { kind: "part", label: "2" },
        ],
        "2",
        "1",
      ),
    ).toBe(false);
  });
});

describe("labels", () => {
  it("refuses a subpart label as part, and a part label as subpart", () => {
    const part = ProvisionShape.part.safeParse("Subpart 1");
    expect(part.success).toBe(false);
    expect(JSON.stringify(part.error?.issues)).toContain("pass it as subpart");
    const subpart = ProvisionShape.subpart.safeParse("Part 2");
    expect(subpart.success).toBe(false);
    expect(JSON.stringify(subpart.error?.issues)).toContain("pass it as part");
    expect(ProvisionShape.part.safeParse("Part 2").success).toBe(true);
    expect(ProvisionShape.subpart.safeParse("CB").success).toBe(true);
  });

  it("describes enclosing parts for output", () => {
    expect(describeEnclosing({ kind: "part", label: "C" })).toBe("Part C");
    expect(describeEnclosing({ kind: "subpart", label: "CZ" })).toBe("Subpart CZ");
    expect(describeEnclosing({ kind: "part", label: "Part A" })).toBe("Part A");
    expect(describeEnclosing({ kind: "subpart", label: "" })).toBe("Subpart");
  });
});

describe("review follow-ups", () => {
  const ITA_ID = "act_public_2007_97_en_2025-05-29";
  const itaRecord = () =>
    json({ work_id: "act_public_2007_97", version_id: ITA_ID, title: "ITA", formats: [] });

  it("says when a subpart label was passed as part, and a part label as subpart", async () => {
    const run = (args: { part?: string; subpart?: string }) =>
      getTableOfContents.run(
        { version_id: ITA_ID, ...args },
        deps([itaRecord()], "x", { [ITA_ID]: ITA }).deps,
        signal,
      );
    const asPart = await run({ part: "BB" });
    expect(asPart.entries).toEqual([]);
    expect(asPart.notes.join(" ")).toContain(
      '"BB" is a subpart (in Part B): pass subpart "BB" with part "B".',
    );
    const asSubpart = await run({ subpart: "B" });
    expect(asSubpart.notes.join(" ")).toContain('"B" is a part: pass part "B".');
    await expect(
      getProvisionText.run(
        { version_id: ITA_ID, section: "BB 1", part: "BB" },
        deps([itaRecord()], "x", { [ITA_ID]: ITA }).deps,
        signal,
      ),
    ).rejects.toThrow(
      'section BB 1 was not found within part BB in act_public_2007_97_en_2025-05-29. "BB" is a subpart (in Part B)',
    );
  });

  it("lists each entry's enclosing parts and subparts", async () => {
    const out = await toc({ part: "2" });
    const s30 = out.entries.find((e) => e.label === "30");
    expect(s30?.within).toEqual(["Part 2", "Subpart 1"]);
  });

  // Two subparts inside one part, each with a clause 1, so only subpart can decide.
  const clause = (word: string) =>
    `<prov><label>1</label><heading>${word}</heading><prov.body><subprov><label/><para><text>${word} ${"x".repeat(1200)}</text></para></subprov></prov.body></prov>`;
  const sched = (second: string) =>
    `<act><body/><schedule.group><schedule><label>1</label><heading>S</heading><schedule.provisions><part><label>1</label><heading>P1</heading><subpart><label>1</label><heading>S1</heading>${clause("Alpha")}</subpart><subpart><label>2</label><heading>S2</heading>${clause(second)}</subpart></part></schedule.provisions></schedule></schedule.group></act>`;
  const V1 = "act_public_2099_4_en_2099-01-01";
  const V2 = "act_public_2099_4_en_2099-06-01";
  const rec = (id: string) =>
    json({ work_id: "act_public_2099_4", version_id: id, title: "T", formats: [] });

  it("keeps subparts apart in the text cache and in continue_with", async () => {
    const base = deps([rec(V1), rec(V1)], "x", { [V1]: sched("Beta") });
    const d = { ...base.deps, textCache: new MemoryCache(10) };
    const pick = (subpart: string) =>
      getProvisionText.run(
        { version_id: V1, section: "1", schedule: "1", part: "1", subpart, max_chars: 1000 },
        d,
        signal,
      );
    expect((await pick("1")).text).toContain("Alpha");
    const second = await pick("2");
    expect(second.text).toContain("Beta");
    expect(second.continue_with).toEqual({
      version_id: V1,
      offset: 1000,
      max_chars: 1000,
      section: "1",
      schedule: "1",
      part: "1",
      subpart: "2",
    });
  });

  it("echoes include_history in continue_with", async () => {
    const out = await getProvisionText.run(
      { version_id: V1, schedule: "1", include_history: true, max_chars: 1000 },
      deps([rec(V1)], "x", { [V1]: sched("Beta") }).deps,
      signal,
    );
    expect(out.continue_with).toEqual({
      version_id: V1,
      offset: 1000,
      max_chars: 1000,
      schedule: "1",
      include_history: true,
    });
  });

  it("hints at subpart for a top-level subpart label passed as part", async () => {
    const xml =
      "<act><body><subpart><label>7</label><heading>Loose</heading></subpart></body></act>";
    const id = "act_public_2099_6_en_2099-01-01";
    const out = await getTableOfContents.run(
      { version_id: id, part: "7" },
      deps([json({ work_id: "act_public_2099_6", version_id: id, title: "T", formats: [] })], "x", {
        [id]: xml,
      }).deps,
      signal,
    );
    expect(out.notes.join(" ")).toContain('"7" is a subpart: pass subpart "7".');
  });

  it("compares the chosen subpart on both sides", async () => {
    const out = await compareVersions.run(
      {
        work_id: "act_public_2099_4",
        section: "1",
        schedule: "1",
        part: "1",
        subpart: "2",
        from_version_id: V1,
        to_version_id: V2,
      },
      deps([rec(V1), rec(V2)], "x", { [V1]: sched("Beta"), [V2]: sched("Gamma") }).deps,
      signal,
    );
    expect(out.provision.within).toEqual(["Part 1", "Subpart 2"]);
    expect(out.diff).toContain("- 1 Beta");
    expect(out.diff).toContain("+ 1 Gamma");
    expect(out.diff).not.toContain("Alpha");
  });

  it("names the scope when a comparison finds nothing in it", async () => {
    await expect(
      compareVersions.run(
        {
          work_id: "act_public_2099_4",
          section: "1",
          schedule: "1",
          part: "9",
          from_version_id: V1,
          to_version_id: V2,
        },
        deps([rec(V1), rec(V2)], "x", { [V1]: sched("Beta"), [V2]: sched("Gamma") }).deps,
        signal,
      ),
    ).rejects.toThrow("was not found within part 9 in either version.");
  });

  it("treats a head1 labelled Subpart as a subpart, and leaves word labels unprefixed", async () => {
    const xml =
      "<act><body/><schedule.group><schedule><label>1</label><heading>S</heading><schedule.misc>" +
      '<head1 type="part"><label>Subpart 2</label><heading>H</heading><prov><label>1</label><heading>C</heading></prov></head1>' +
      "</schedule.misc></schedule></schedule.group></act>";
    const doc = await readLegislation(chunked(xml), {
      target: { section: "1", schedule: "1", subpart: "2" },
    });
    expect(doc.found?.within).toEqual([{ kind: "subpart", label: "Subpart 2" }]);
    expect(describeEnclosing({ kind: "part", label: "Form 1" })).toBe("Form 1");
  });
});
