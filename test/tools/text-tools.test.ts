import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/api/cache.js";
import { compareVersions } from "../../src/tools/compare-versions.js";
import { getProvisionText } from "../../src/tools/get-provision-text.js";
import { getTableOfContents } from "../../src/tools/get-table-of-contents.js";
import { ToolInputError } from "../../src/tools/shared.js";
import { json } from "../api/fake-fetch.js";
import { bigAct, loadXml } from "../text/xml.js";
import { deps, signal, versionsPage } from "./harness.js";

const WORK = "act_public_1976_33";
const V2014 = `${WORK}_en_2014-01-01`;
const V2007 = `${WORK}_en_2007-09-18`;
const WAITANGI = loadXml("waitangi-day-act-1976.xml");
const versionRecord = (id: string) =>
  json({ work_id: WORK, version_id: id, title: "Waitangi Day Act 1976", formats: [] });

describe("get_table_of_contents", () => {
  it("returns the whole outline of a small Act", async () => {
    const { deps: d } = deps([versionRecord(V2014)], "2026-11-02", { [V2014]: WAITANGI });
    const out = await getTableOfContents.run({ version_id: V2014 }, d, signal);
    expect(getTableOfContents.outputSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      title: "Waitangi Day Act 1976",
      total_entries: 9,
      truncated: false,
      scope: "The whole document.",
    });
    expect(out.entries[6]).toEqual({
      kind: "section",
      label: "6A",
      heading: "Relationship with Holidays Act 2003",
      depth: 0,
      schedule: null,
      repealed: false,
    });
  });

  it("summarises a large Act and lists one part on request", async () => {
    const loose =
      "<prov><label>0</label><heading>Preliminary</heading><prov.body><subprov><label/><para><text>x</text></para></subprov></prov.body></prov>";
    const big = bigAct(4, 100, loose);
    const id = "act_public_2099_1_en_2099-01-01";
    const { deps: d } = deps(
      [versionRecord(id), versionRecord(id), versionRecord(id)],
      "2026-11-02",
      { [id]: big },
    );
    const top = await getTableOfContents.run({ version_id: id }, d, signal);
    expect(top.entries.map((e) => e.kind)).toEqual([
      "section",
      ...Array.from({ length: 4 }, () => ["part", "subpart"]).flat(),
      "schedule",
    ]);
    expect(top.notes.join(" ")).toContain("Pass part");
    const part2 = await getTableOfContents.run({ version_id: id, part: "2A" }, d, signal);
    expect(part2.entries.filter((e) => e.kind === "section")).toHaveLength(100);
    const missing = await getTableOfContents.run({ version_id: id, part: "Z" }, d, signal);
    expect(missing.entries).toEqual([]);
    expect(missing.notes.join(" ")).toContain('No part or subpart labelled "Z"');
  });

  it("lists subparts when a part is too big, and caps listings without subparts", async () => {
    const id = "act_public_2099_2_en_2099-01-01";
    const { deps: d } = deps([versionRecord(id), versionRecord(id)], "2026-11-02", {
      [id]: bigAct(1, 600),
    });
    const out = await getTableOfContents.run({ version_id: id, part: "Part 1" }, d, signal);
    expect(out.entries.map((e) => `${e.kind}:${e.label}`)).toEqual(["part:1", "subpart:1A"]);
    expect(out.notes.join(" ")).toContain('"Part 1" has 602 entries, too many to list at once');
    const sections = Array.from(
      { length: 600 },
      (_, i) => `<prov><label>${String(i + 1)}</label><heading>S</heading></prov>`,
    ).join("");
    const flat = `<act><body><part><label>1</label><heading>Only</heading>${sections}</part></body></act>`;
    const flatId = "act_public_2099_7_en_2099-01-01";
    const { deps: d2 } = deps([versionRecord(flatId)], "x", { [flatId]: flat });
    const capped = await getTableOfContents.run({ version_id: flatId, part: "1" }, d2, signal);
    expect(capped.truncated).toBe(true);
    expect(capped.entries).toHaveLength(500);
  });

  it("falls back to the API title when the XML has none", async () => {
    const id = "act_public_2099_3_en_2099-01-01";
    const { deps: d } = deps([versionRecord(id)], "2026-11-02", { [id]: "<act><body/></act>" });
    const out = await getTableOfContents.run({ version_id: id }, d, signal);
    expect(out.title).toBe("Waitangi Day Act 1976");
  });
});

describe("table of contents with schedules", () => {
  it("lists only body parts for a part filter, not schedule parts with the same label", async () => {
    const id = "act_public_2099_10_en_2099-01-01";
    const xml =
      "<act><body><part><label>A</label><heading>Body A</heading><prov><label>1</label><heading>S</heading></prov></part></body>" +
      "<schedule.group><schedule><label>1</label><heading>Sch</heading><schedule.provisions><part><label>A</label><heading>Sched A</heading><prov><label>1</label><heading>C</heading></prov></part></schedule.provisions></schedule></schedule.group></act>";
    const { deps: d } = deps([versionRecord(id)], "x", { [id]: xml });
    const out = await getTableOfContents.run({ version_id: id, part: "A" }, d, signal);
    expect(out.entries.map((e) => `${e.kind}:${e.heading}`)).toEqual(["part:Body A", "section:S"]);
  });

  it("labels schedule clauses with their schedule", async () => {
    const id = "act_public_2099_9_en_2099-01-01";
    const { deps: d } = deps([versionRecord(id)], "x", {
      [id]: loadXml("synthetic-structures.xml"),
    });
    const out = await getTableOfContents.run({ version_id: id }, d, signal);
    expect(out.entries.find((e) => e.schedule === "1" && e.kind === "section")).toMatchObject({
      label: "1",
      heading: "Application",
    });
  });
});

describe("get_provision_text", () => {
  it("returns a short section as at a date, in one page", async () => {
    const { deps: d } = deps(
      [json(versionsPage(WORK, ["2014-01-01", "2007-09-18"]))],
      "2026-11-02",
      {
        [V2014]: WAITANGI,
      },
    );
    const out = await getProvisionText.run(
      { work_id: WORK, section: "4", max_chars: 1000 },
      d,
      signal,
    );
    expect(getProvisionText.outputSchema.parse(out)).toEqual(out);
    expect(out.provision).toMatchObject({
      kind: "section",
      label: "4",
      heading: "Observance of Waitangi Day",
    });
    expect(out.text.startsWith("4 Observance of Waitangi Day")).toBe(true);
    expect(out.notes.join(" ")).toContain("as_at defaulted");
    // Section 4 is shorter than max_chars, so there is no next page.
    expect(out.next_offset).toBeNull();
  });

  it("continues a section from next_offset when the version is chosen by date", async () => {
    const page = (offset?: number) =>
      getProvisionText.run(
        { work_id: WORK, section: "4", max_chars: 50, ...(offset === undefined ? {} : { offset }) },
        deps([json(versionsPage(WORK, ["2014-01-01"]))], "2026-11-02", { [V2014]: WAITANGI }).deps,
        signal,
      );
    const first = await page();
    expect(first.text).toHaveLength(50);
    expect(first.next_offset).toBe(50);
    const second = await page(50);
    expect(second.offset).toBe(50);
    expect(second.text.startsWith(first.text)).toBe(false);
    expect(second.next_offset).toBe(100);
  });

  it("never splits a character across pages", async () => {
    // The rendered text is "1 Symbols\n(1) " (14 characters) then the paragraph, so 985 "a"s put
    // the two halves of the maths symbol at offsets 999 and 1000: across the first page boundary.
    const X = "\u{1D465}";
    const MATHS = `<act><cover><title>Maths Act</title></cover><body><prov><label>1</label><heading>Symbols</heading><prov.body><subprov><label>1</label><para><text>${"a".repeat(985)}${X}${"b".repeat(1500)}</text></para></subprov></prov.body></prov></body></act>`;
    const page = (offset?: number) =>
      getProvisionText.run(
        {
          version_id: V2014,
          section: "1",
          max_chars: 1000,
          ...(offset === undefined ? {} : { offset }),
        },
        deps([versionRecord(V2014)], "2026-11-02", { [V2014]: MATHS }).deps,
        signal,
      );
    const first = await page();
    expect(first.text).toHaveLength(999);
    expect(first.next_offset).toBe(999);
    const second = await page(999);
    expect(second.text.startsWith(X)).toBe(true);
    const full = `1 Symbols\n(1) ${"a".repeat(985)}${X}${"b".repeat(1500)}`;
    expect(first.text + second.text).toBe(full.slice(0, 999 + second.text.length));
    // An offset in the middle of the pair is moved back to the start of the character.
    expect((await page(1000)).offset).toBe(999);
  });

  it("pages long text with next_offset", async () => {
    const { deps: d } = deps([versionRecord(V2014), versionRecord(V2014)], "2026-11-02", {
      [V2014]: WAITANGI,
    });
    const first = await getProvisionText.run(
      { version_id: V2014, schedule: "", max_chars: 1000 },
      d,
      signal,
    );
    expect(first.text).toHaveLength(1000);
    expect(first.next_offset).toBe(1000);
    const second = await getProvisionText.run(
      { version_id: V2014, schedule: "", offset: 1000, max_chars: 50_000 },
      d,
      signal,
    );
    expect(second.next_offset).toBeNull();
    expect(second.offset + second.text.length).toBe(second.total_chars);
  });

  it("explains a missing section with nearby labels", async () => {
    const { deps: d } = deps([versionRecord(V2014)], "2026-11-02", { [V2014]: WAITANGI });
    const run = getProvisionText.run({ version_id: V2014, section: "6B" }, d, signal);
    await expect(run).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      getProvisionText.run(
        { version_id: V2014, section: "6B" },
        deps([versionRecord(V2014)], "x", { [V2014]: WAITANGI }).deps,
        signal,
      ),
    ).rejects.toThrow('Labels near "6B": 6, 6A');
  });

  it("says 'none' when a document has no sections to suggest", async () => {
    const id = "act_public_2099_4_en_2099-01-01";
    const { deps: d } = deps([versionRecord(id)], "x", { [id]: "<act><body/></act>" });
    await expect(getProvisionText.run({ version_id: id, section: "1" }, d, signal)).rejects.toThrow(
      'Labels near "1": none',
    );
  });

  it("clamps an offset past the end and falls back to the API title", async () => {
    const id = "act_public_2099_5_en_2099-01-01";
    const xml =
      "<act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label/><para><text>Short.</text></para></subprov></prov.body></prov></body></act>";
    const { deps: d } = deps([versionRecord(id)], "x", { [id]: xml });
    const out = await getProvisionText.run(
      { version_id: id, section: "1", offset: 9999 },
      d,
      signal,
    );
    expect(out).toMatchObject({
      text: "",
      offset: out.total_chars,
      next_offset: null,
      title: "Waitangi Day Act 1976",
    });
  });

  it("reads a clause inside a schedule", async () => {
    const id = "act_public_2099_6_en_2099-01-01";
    const { deps: d } = deps([versionRecord(id)], "x", {
      [id]: loadXml("synthetic-structures.xml"),
    });
    const out = await getProvisionText.run(
      { version_id: id, section: "1", schedule: "1" },
      d,
      signal,
    );
    expect(out.provision).toMatchObject({ label: "1", heading: "Application", schedule: "1" });
    expect(out.text).toBe("1 Application\nThis clause applies from 2099.");
  });

  it("notes duplicates and repeals (real extracts)", async () => {
    const id = "act_public_2099_8_en_2099-01-01";
    const real = loadXml("real-extracts.xml");
    const { deps: d } = deps([versionRecord(id), versionRecord(id)], "x", { [id]: real });
    const cz23 = await getProvisionText.run({ version_id: id, section: "CZ 23" }, d, signal);
    expect(cz23.provision.repealed).toBe(false);
    expect(cz23.notes.join(" ")).toContain(
      "This label appears 2 times (in C > CZ (repealed); in C > CZ). Used the one in C > CZ.",
    );
    const s24 = await getProvisionText.run({ version_id: id, section: "24" }, d, signal);
    expect(s24.provision.repealed).toBe(true);
    expect(s24.notes.join(" ")).toContain("has been repealed");
  });

  it("reuses rendered text from the optional cache when paging", async () => {
    let downloads = 0;
    const base = deps([versionRecord(V2014), versionRecord(V2014)], "x", { [V2014]: WAITANGI });
    const counting: typeof base.deps.xml = (versionId, s) => {
      downloads += 1;
      return base.deps.xml(versionId, s);
    };
    const d = { ...base.deps, xml: counting, textCache: new MemoryCache(10) };
    const first = await getProvisionText.run(
      { version_id: V2014, schedule: "", max_chars: 1000 },
      d,
      signal,
    );
    await getProvisionText.run(
      { version_id: V2014, schedule: "", max_chars: 1000, offset: first.next_offset ?? 0 },
      d,
      signal,
    );
    expect(downloads).toBe(1);
  });

  it("explains a missing schedule", async () => {
    const { deps: d } = deps([versionRecord(V2014)], "2026-11-02", { [V2014]: WAITANGI });
    await expect(
      getProvisionText.run({ version_id: V2014, schedule: "9" }, d, signal),
    ).rejects.toThrow("schedule 9 was not found");
  });

  it.each([
    [{ version_id: V2014 }, "Provide section, schedule, or both"],
    [{ version_id: V2014, section: "1; DROP" }, "Use the label as printed"],
    [{ version_id: V2014, section: "1", max_chars: 10 }, "Too small"],
  ])("validates input %j", (input, message) => {
    const r = getProvisionText.inputSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(message);
  });
});

describe("compare_versions", () => {
  const changed = WAITANGI.replace("This Act shall bind the Crown.", "This Act binds the Crown.");

  it("shows a line diff between two versions", async () => {
    const { deps: d } = deps([versionRecord(V2007), versionRecord(V2014)], "2026-11-02", {
      [V2007]: changed,
      [V2014]: WAITANGI,
    });
    const out = await compareVersions.run(
      { work_id: WORK, section: "2", from_version_id: V2007, to_version_id: V2014 },
      d,
      signal,
    );
    expect(compareVersions.outputSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      changed: true,
      lines_added: 1,
      lines_removed: 1,
      same_version: false,
    });
    expect(out.diff).toBe(
      "  2 Act to bind Crown\n- This Act binds the Crown.\n+ This Act shall bind the Crown.",
    );
  });

  it("resolves dates and reports when both resolve to the same version", async () => {
    const page = json(versionsPage(WORK, ["2014-01-01", "2007-09-18"]));
    const { deps: d } = deps(
      [page, json(versionsPage(WORK, ["2014-01-01", "2007-09-18"]))],
      "2026-11-02",
      {
        [V2014]: WAITANGI,
      },
    );
    const out = await compareVersions.run(
      { work_id: WORK, section: "2", from_as_at: "2020-01-01" },
      d,
      signal,
    );
    expect(out).toMatchObject({ same_version: true, changed: false, diff: "" });
    expect(out.notes.join(" ")).toContain("same version");
  });

  it("reports a provision added or removed between versions", async () => {
    const without6A = WAITANGI.replace(/<prov [^>]*><label[^>]*>6A<\/label>[\s\S]*?<\/prov>/u, "");
    const { deps: d } = deps([versionRecord(V2007), versionRecord(V2014)], "x", {
      [V2007]: without6A,
      [V2014]: WAITANGI,
    });
    const out = await compareVersions.run(
      { work_id: WORK, section: "6A", from_version_id: V2007, to_version_id: V2014 },
      d,
      signal,
    );
    expect(out.from.found).toBe(false);
    expect(out.notes.join(" ")).toContain("was added");
    expect(out.diff.split("\n").every((l) => l.startsWith("+ "))).toBe(true);

    const reverse = deps([versionRecord(V2014), versionRecord(V2007)], "x", {
      [V2007]: without6A,
      [V2014]: WAITANGI,
    });
    const back = await compareVersions.run(
      { work_id: WORK, section: "6A", from_version_id: V2014, to_version_id: V2007 },
      reverse.deps,
      signal,
    );
    expect(back.notes.join(" ")).toContain("repealed or renumbered");
  });

  it("explains a provision missing from both versions", async () => {
    const { deps: d } = deps([versionRecord(V2007), versionRecord(V2014)], "x", {
      [V2007]: WAITANGI,
      [V2014]: WAITANGI,
    });
    await expect(
      compareVersions.run(
        { work_id: WORK, section: "99", from_version_id: V2007, to_version_id: V2014 },
        d,
        signal,
      ),
    ).rejects.toThrow("not found in either version");
  });

  it("refuses changes too large to diff, but compares long provisions with small changes", async () => {
    const doc = (word: string, n: number) =>
      `<act><body><prov><label>1</label><heading>Long</heading><prov.body><subprov><label/>${Array.from(
        { length: n },
        (_, i) => `<para><text>${word} ${String(i)}</text></para>`,
      ).join("")}</subprov></prov.body></prov></body></act>`;
    const tooBig = deps([versionRecord(V2007), versionRecord(V2014)], "x", {
      [V2007]: doc("old", 2100),
      [V2014]: doc("new", 2100),
    });
    await expect(
      compareVersions.run(
        { work_id: WORK, section: "1", from_version_id: V2007, to_version_id: V2014 },
        tooBig.deps,
        signal,
      ),
    ).rejects.toThrow("too long to compare");

    // 5,000 lines with one change near the end: still compared, and the change is visible.
    const long = doc("same", 5000);
    const small = deps([versionRecord(V2007), versionRecord(V2014)], "x", {
      [V2007]: long,
      [V2014]: long.replace("same 4990<", "changed 4990<"),
    });
    const out = await compareVersions.run(
      { work_id: WORK, section: "1", from_version_id: V2007, to_version_id: V2014 },
      small.deps,
      signal,
    );
    expect(out.diff).toBe(
      "  same 4988\n  same 4989\n- same 4990\n+ changed 4990\n  same 4991\n  same 4992",
    );
  });

  it("truncates very long diffs", async () => {
    const paras = (word: string) =>
      Array.from(
        { length: 1500 },
        (_, i) => `<para><text>${word} ${String(i)} ${"x".repeat(20)}</text></para>`,
      ).join("");
    const doc = (word: string) =>
      `<act><body><prov><label>1</label><heading>L</heading><prov.body><subprov><label/>${paras(word)}</subprov></prov.body></prov></body></act>`;
    const { deps: d } = deps([versionRecord(V2007), versionRecord(V2014)], "x", {
      [V2007]: doc("old"),
      [V2014]: doc("new"),
    });
    const out = await compareVersions.run(
      { work_id: WORK, section: "1", from_version_id: V2007, to_version_id: V2014 },
      d,
      signal,
    );
    expect(out.diff_truncated).toBe(true);
    expect(out.diff.length).toBe(30_000);
  });

  it.each([
    [{ work_id: WORK, section: "1" }, "exactly one of from_as_at or from_version_id"],
    [{ work_id: WORK, from_as_at: "2020-01-01" }, "Provide section, schedule, or both"],
    [
      {
        work_id: WORK,
        section: "1",
        from_as_at: "2020-01-01",
        to_as_at: "2021-01-01",
        to_version_id: V2014,
      },
      "at most one",
    ],
    [
      { work_id: WORK, section: "1", from_version_id: "act_public_2007_97_en_2010-04-01" },
      "must be a version of",
    ],
  ])("validates input %j", (input, message) => {
    const r = compareVersions.inputSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(message);
  });
});
