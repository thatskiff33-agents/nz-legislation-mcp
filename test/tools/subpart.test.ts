// Part and subpart are distinct (issue #41): in modern Acts subpart numbers restart in each part,
// as in the Health and Safety at Work Act 2015 (Part 1 and Part 2 both have Subparts 1 and 2).
import { describe, expect, it } from "vitest";
import { isWithin, readLegislation } from "../../src/text/document.js";
import { getProvisionText } from "../../src/tools/get-provision-text.js";
import { getTableOfContents } from "../../src/tools/get-table-of-contents.js";
import { describeEnclosing, ProvisionShape } from "../../src/tools/text-common.js";
import { json } from "../api/fake-fetch.js";
import { chunked, loadXml } from "../text/xml.js";
import { deps, signal } from "./harness.js";

const HSWA = loadXml("health-and-safety-at-work-act-2015-parts-1-2.xml");
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
