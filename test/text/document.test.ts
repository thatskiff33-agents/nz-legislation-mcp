import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { normaliseLabel, normalisePartLabel, readLegislation } from "../../src/text/document.js";
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
      within: [
        { kind: "part", label: "B" },
        { kind: "subpart", label: "BB" },
      ],
    });
    expect(doc.outline.find((e) => e.label === "BB")).toMatchObject({
      kind: "subpart",
      depth: 1,
      within: [{ kind: "part", label: "B" }],
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
    expect(
      unnumbered.text?.startsWith(
        "The Treaty of Waitangi\n[Empowering provision: s 3]\nHER MAJESTY VICTORIA",
      ),
    ).toBe(true);
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
    ["cl. 2", "cl. 2"],
    ["ss 3", "ss 3"],
    ["CL 1", "cl 1"],
    ["s2", "2"],
    ["section 2.", "2"],
    ["sections CB 6A", "cb 6a"],
    ["Sch. 1A", "1a"],
  ])("%j -> %j", (input, expected) => {
    expect(normaliseLabel(input)).toBe(expected);
  });
});

describe("normalisePartLabel", () => {
  it.each([
    ["Part C", "c"],
    ["subpart CB", "cb"],
    ["C", "c"],
    ["Part 3B", "3b"],
  ])("%j -> %j", (input, expected) => {
    expect(normalisePartLabel(input)).toBe(expected);
  });
});

describe("structure fidelity", () => {
  const one = (xml: string, section: string) =>
    readLegislation(chunked(`<act><cover><title>T</title></cover><body>${xml}</body></act>`), {
      target: { section },
    });

  it("returns closing words to the enclosing subsection's indent", async () => {
    const doc = await one(
      "<prov><label>2</label><heading>Lists</heading><prov.body><subprov><label>1</label><para><text>Lead in—</text><label-para><label>a</label><para><text>alpha; or</text></para></label-para><label-para><label>b</label><para><text>beta,</text></para></label-para><text>closing words.</text></para></subprov></prov.body></prov>",
      "2",
    );
    expect(doc.text).toBe("2 Lists\n(1) Lead in—\n  (a) alpha; or\n  (b) beta,\nclosing words.");
  });

  it("returns closing words after a nested list to the outer paragraph's indent", async () => {
    const doc = await one(
      "<prov><label>3</label><heading>Nested</heading><prov.body><subprov><label>1</label><para><text>Lead in—</text><label-para><label>a</label><para><text>where—</text><label-para><label>i</label><para><text>one; or</text></para></label-para><text>inner closing,</text></para></label-para></para></subprov></prov.body></prov>",
      "3",
    );
    expect(doc.text).toBe(
      "3 Nested\n(1) Lead in—\n  (a) where—\n    (i) one; or\n  inner closing,",
    );
  });

  const P = (inner: string) =>
    `<prov><label>1</label><heading>H</heading><prov.body><subprov><label>1</label><para>${inner}</para></subprov></prov.body></prov>`;

  it("keeps a closing quotation mark and full stop on the quoted list's last line", async () => {
    const doc = await one(
      P(
        '<text>Insert: </text><amend.in quote="1"><label-para><label>a</label><para><text>one; and</text></para></label-para><label-para><label>b</label><para><text>two</text></para></label-para></amend.in><text>.</text>',
      ),
      "1",
    );
    expect(doc.text).toBe("1 H\n(1) Insert: “\n  (a) one; and\n  (b) two”.");
  });

  it("keeps table cells on one row after a list inside a cell", async () => {
    const doc = await one(
      P(
        "<table><tgroup><tbody><row><entry><label-para><label>a</label><para><text>cell a</text></para></label-para></entry><entry><text>cell 2</text></entry></row></tbody></tgroup></table>",
      ),
      "1",
    );
    expect(doc.text).toBe("1 H\n(1)\n  (a) cell a | cell 2 |");
  });

  it("starts closing words on a new line after list items and formula variables", async () => {
    const list = await one(
      P(
        "<text>Lead—</text><list><item><label>1</label><para><text>one</text></para></item><item><label>2</label><para><text>two</text></para></item></list><text>closing words.</text>",
      ),
      "1",
    );
    expect(list.text).toBe("1 H\n(1) Lead—\n1 one\n2 two\nclosing words.");
    const formula = await one(
      P(
        "<text>where—</text><variable-def><variable>a</variable><text>is x</text></variable-def><text>closing words.</text>",
      ),
      "1",
    );
    expect(formula.text).toBe("1 H\n(1) where—\na is x\nclosing words.");
  });

  /** A two-item list then `after`, returning the lines from item (b) on. */
  const afterList = async (after: string) =>
    (
      await one(
        P(
          `<text>Lead—</text><label-para><label>a</label><para><text>alpha; or</text></para></label-para><label-para><label>b</label><para><text>beta,</text></para></label-para>${after}`,
        ),
        "1",
      )
    ).text
      ?.split("\n")
      .slice(3);

  it("starts closing words that open with a quotation mark or bracket on a new line", async () => {
    expect(
      await afterList('<amend.in quote="1">land</amend.in><text> includes buildings.</text>'),
    ).toEqual(["  (b) beta,", "“land” includes buildings."]);
    expect(
      await afterList(
        "<text>(</text><citation><intref>section 5</intref></citation><text>) applies.</text>",
      ),
    ).toEqual(["  (b) beta,", "(section 5) applies."]);
  });

  it("keeps punctuation that continues the last item on its line", async () => {
    expect(await afterList("<text>; and</text>")).toEqual(["  (b) beta,; and"]);
    expect(await afterList("<text>.</text>")).toEqual(["  (b) beta,."]);
  });

  it("still breaks before words that follow a graphic after a list", async () => {
    expect(await afterList("<figure><graphic/></figure><text>closing words.</text>")).toEqual([
      "  (b) beta, [graphic omitted]",
      "closing words.",
    ]);
  });

  it("replaces lone surrogates with the replacement character (defence in depth)", async () => {
    // UTF-8 decoding cannot produce a lone surrogate, but text handed in as a string can.
    const doc = await one(P("<text>bad \uD800 char</text>"), "1");
    expect(doc.text).toBe("1 H\n(1) bad � char");
  });

  it("puts each signature line on its own line (Treaty of Waitangi schedule)", async () => {
    const doc = await readLegislation(chunked(WAITANGI), { target: { schedule: "" } });
    const lines = doc.text?.split("\n") ?? [];
    const hobson = lines.indexOf("W Hobson,");
    expect(hobson).toBeGreaterThan(0);
    expect(lines[hobson + 1]).toBe("Lieutenant Governor.");
    expect(lines[hobson + 2]?.startsWith("Now therefore We the Chiefs")).toBe(true);
    expect(doc.text).not.toContain("Subjects.W Hobson");
  });
});

describe("real extracts (GST Act 1985, Income Tax Act 2007)", () => {
  const REAL = loadXml("real-extracts.xml");
  const read = (target: { section?: string; schedule?: string; part?: string; subpart?: string }) =>
    readLegislation(chunked(REAL), { target });

  it("keeps quoted statutory words, in quotation marks (ITA YC 20)", async () => {
    const doc = await read({ section: "YC 20" });
    expect(doc.text).toContain(
      "(b) each other reference to “excluded fixed rate security” were omitted.",
    );
    expect(doc.text).toContain("the words “an excluded fixed rate security” were replaced by “a”.");
  });

  it("marks repealed provisions and parts of provisions", async () => {
    expect((await read({ section: "24" })).text).toBe("24 Tax invoices [Repealed]");
    const cb6 = await read({ section: "CB 6" });
    expect(cb6.found?.repealed).toBe(false);
    expect(cb6.text?.split("\n").at(-1)).toBe("(3) [Repealed]");
  });

  it("prefers the live provision when a label is duplicated (ITA CZ 23)", async () => {
    const doc = await read({ section: "CZ 23" });
    expect(doc.matches.map((m) => m.entry.repealed)).toEqual([true, false]);
    expect(doc.found?.repealed).toBe(false);
    expect(doc.text?.startsWith("CZ 23 Employee benefits for Canterbury earthquake relief")).toBe(
      true,
    );
  });

  it("puts formula variables at the start of their definition (GST s 19C)", async () => {
    const lines = (await read({ section: "19C" })).text?.split("\n") ?? [];
    expect(lines).toContain("a − b");
    expect(lines.some((l) => l.startsWith("a is an amount equal to"))).toBe(true);
    expect(lines.some((l) => l.startsWith("b is an amount equal to"))).toBe(true);
    expect(lines.some((l) => /[a-z]b$/u.test(l) || l.endsWith("andb"))).toBe(false);
  });

  it("puts closing words after a list on their own line, not in the last item (GST s 19C(9))", async () => {
    const lines = (await read({ section: "19C" })).text?.split("\n") ?? [];
    const c = lines.findIndex((l) =>
      l.startsWith("  (c) from a hybrid basis to an invoice or a payments basis"),
    );
    expect(c).toBeGreaterThan(0);
    expect(lines[c - 1]?.startsWith("  (b) from a payments basis")).toBe(true);
    expect(lines[c + 1]).toBe(
      "shall be deemed to have been deducted, or accounted for, as the case may be, pursuant to section 20(3).",
    );
  });

  it("puts list numbers on their own items (ITA schedule 21)", async () => {
    const lines = (await read({ schedule: "21" })).text?.split("\n") ?? [];
    expect(lines).toContain(
      "1 Preproduction activities, including demonstration of commercial viability and tooling up.",
    );
    expect(lines).toContain("2 Routine de-bugging of existing computer software.");
    expect(lines).toContain("5 [Repealed]");
    expect(lines[1]).toBe("[Empowering provision: s LY 2]");
    expect(lines[2]?.startsWith("Part A ")).toBe(true);
  });

  it("does not duplicate headings that contain markup (ITA CB 15D)", async () => {
    const first = (await read({ section: "CB 15D" })).text?.split("\n")[0];
    expect(first).toBe("CB 15D Kāinga Ora–Homes and Communities and wholly-owned group");
  });

  it("excludes amending-Act skeletons from the outline and from matching", async () => {
    const doc = await readLegislation(chunked(REAL), {
      fullOutline: true,
      target: { section: "1" },
    });
    expect(doc.found).toBeNull();
    expect(doc.outline.some((e) => e.label === "1" && e.kind === "section")).toBe(false);
  });

  it("lists ird-crosshead cross-headings and repealed flags in the outline", async () => {
    const doc = await readLegislation(chunked(REAL), { fullOutline: true });
    expect(doc.outline.find((e) => e.kind === "crosshead")?.heading).toBe("Business generally");
    expect(doc.outline.filter((e) => e.label === "CZ 23").map((e) => e.repealed)).toEqual([
      true,
      false,
    ]);
    expect(doc.outline.find((e) => e.label === "24")?.repealed).toBe(true);
  });

  it("narrows matches to a part or subpart", async () => {
    expect((await read({ section: "CZ 23", part: "CB" })).found).toBeNull();
    // "CZ" is a subpart: as a part it matches nothing; as a subpart it matches both copies.
    expect((await read({ section: "CZ 23", part: "CZ" })).found).toBeNull();
    expect((await read({ section: "CZ 23", subpart: "Subpart CZ" })).matches).toHaveLength(2);
    expect((await read({ section: "CZ 23", part: "C", subpart: "CZ" })).matches).toHaveLength(2);
    expect((await read({ section: "CZ 23", part: "B", subpart: "CZ" })).found).toBeNull();
  });
});

describe("repealed markers", () => {
  it("marks a repealed provision that has no heading", async () => {
    const xml =
      '<act><body><prov deletion-status="repealed"><label>9</label><prov.body/></prov></body></act>';
    expect((await readLegislation(chunked(xml), { target: { section: "9" } })).text).toBe(
      "9\n[Repealed]",
    );
  });
});

describe("schedule parts and lists", () => {
  it("labels parts and subparts inside a schedule, and unnumbered list items", async () => {
    const xml =
      "<act><body/><schedule.group><schedule><label>3</label><heading>S</heading><schedule.provisions>" +
      "<part><label>Part 1</label><heading>Already worded</heading></part>" +
      "<part><label/><heading>Unnumbered part</heading></part>" +
      "<part><label>2</label><heading>Bare</heading><subpart><label>2A</label><heading>Sub</heading></subpart></part>" +
      "<para><list><item><label/><para><text>unnumbered item</text></para></item></list></para>" +
      "</schedule.provisions></schedule></schedule.group></act>";
    const doc = await readLegislation(chunked(xml), { target: { schedule: "3" } });
    expect(doc.text).toBe(
      [
        "3 S",
        "Part 1 Already worded",
        "Unnumbered part",
        "Part 2 Bare",
        "Subpart 2A Sub",
        "unnumbered item",
      ].join("\n"),
    );
  });
});

describe("matching rules", () => {
  it("never matches an element that has no label of its own", async () => {
    const xml =
      "<act><body/><schedule.group><schedule><heading>Unlabelled</heading><para><text>x</text></para></schedule></schedule.group></act>";
    expect((await readLegislation(chunked(xml), { target: { schedule: "2" } })).found).toBeNull();
    expect((await readLegislation(chunked(xml), { target: { section: "99" } })).found).toBeNull();
  });

  it("collects clause numbers repeated across parts of a schedule", async () => {
    const clause = (n: string, word: string) =>
      `<prov><label>${n}</label><heading>${word}</heading><prov.body><subprov><label/><para><text>${word}</text></para></subprov></prov.body></prov>`;
    const xml = `<act><body/><schedule.group><schedule><label>1</label><heading>S</heading><schedule.provisions><part><label>1</label><heading>P1</heading>${clause("1", "First")}</part><part><label>2</label><heading>P2</heading>${clause("1", "Second")}</part></schedule.provisions></schedule><schedule><label>2</label><heading>T</heading></schedule></schedule.group></act>`;
    const doc = await readLegislation(chunked(xml), { target: { section: "1", schedule: "1" } });
    expect(doc.matches.map((m) => m.entry.within)).toEqual([
      [{ kind: "part", label: "1" }],
      [{ kind: "part", label: "2" }],
    ]);
    const second = await readLegislation(chunked(xml), {
      target: { section: "1", schedule: "1", part: "2" },
    });
    expect(second.text).toBe("1 Second\nSecond");
  });
});

describe("review follow-ups", () => {
  const one = (inner: string) =>
    `<act><body><prov><label>1</label><heading>H</heading><prov.body><subprov><label>1</label><para>${inner}</para></subprov></prov.body></prov></body></act>`;

  it("quotes inline words once, and never quotes whole quoted provisions element by element", async () => {
    const inline = one(
      '<text>the words <amend.in quote="1">old <emphasis>words</emphasis></amend.in> are replaced</text>',
    );
    expect((await readLegislation(chunked(inline), { target: { section: "1" } })).text).toBe(
      "1 H\n(1) the words “old words” are replaced",
    );
    const block = one(
      '<text>replace by:</text><amend quote="1"><prov quote="1"><label quote="1">23</label><heading>Amendment</heading><prov.body quote="1"><subprov quote="1"><label quote="1">a</label><para quote="1"><text>new <quote.in quote="1">inner</quote.in> text</text></para></subprov></prov.body></prov></amend>',
    );
    const text = (await readLegislation(chunked(block), { target: { section: "1" } })).text ?? "";
    expect(text).toContain("23 Amendment");
    expect(text).toContain("(a) new “inner” text");
    expect(text.split("“").length).toBe(text.split("”").length);
    expect(text).not.toContain("““");
  });

  it("keeps a repealed definition's marker on the same line as its term", async () => {
    const xml = one(
      '<text>In this Act,—</text><def-para deletion-status="repealed"><para><text><def-term>excluded day</def-term></text></para></def-para>',
    );
    expect((await readLegislation(chunked(xml), { target: { section: "1" } })).text).toBe(
      "1 H\n(1) In this Act,—\n  [Repealed] excluded day",
    );
  });

  it("removes zero-width characters inside citations", async () => {
    const xml = one("<text>section 20(3)\uFEFF(h) and CB 11(1)\u200B(b)</text>");
    expect((await readLegislation(chunked(xml), { target: { section: "1" } })).text).toBe(
      "1 H\n(1) section 20(3)(h) and CB 11(1)(b)",
    );
  });

  it("removes bidirectional override and isolate controls", async () => {
    const xml = one("<text>pay \u202E01$\u202C and \u2066x\u2069</text>");
    expect((await readLegislation(chunked(xml), { target: { section: "1" } })).text).toBe(
      "1 H\n(1) pay 01$ and x",
    );
  });

  it("lets part pick a clause inside a schedule part marked up as head1", async () => {
    const clause = (word: string) =>
      `<prov><label>1</label><heading>${word}</heading><prov.body><subprov><label/><para><text>${word}</text></para></subprov></prov.body></prov>`;
    const xml = `<act><body/><schedule.group><schedule><label>1</label><heading>Rates</heading><schedule.misc><head1 type="part"><label>Part A</label><heading>First</heading>${clause("Alpha")}</head1><head1 type="part"><label>Part B</label><heading>Second</heading>${clause("Beta")}</head1></schedule.misc></schedule></schedule.group></act>`;
    const all = await readLegislation(chunked(xml), { target: { section: "1", schedule: "1" } });
    expect(all.matches.map((m) => m.entry.within)).toEqual([
      [{ kind: "part", label: "Part A" }],
      [{ kind: "part", label: "Part B" }],
    ]);
    const b = await readLegislation(chunked(xml), {
      target: { section: "1", schedule: "1", part: "B" },
    });
    expect(b.text).toBe("1 Beta\nBeta");
  });

  it("shows the empowering provision after the header whatever its position, and skips empty ones", async () => {
    const xml =
      "<act><body/><schedule.group>" +
      "<schedule><label>1</label><heading>After</heading><empowering-prov><citation>s 9</citation></empowering-prov><para><text>Body.</text></para></schedule>" +
      "<schedule><label>2</label><empowering-prov> </empowering-prov><heading>Empty</heading><para><text>Body.</text></para></schedule>" +
      "</schedule.group></act>";
    expect((await readLegislation(chunked(xml), { target: { schedule: "1" } })).text).toBe(
      "1 After\n[Empowering provision: s 9]\nBody.",
    );
    expect((await readLegislation(chunked(xml), { target: { schedule: "2" } })).text).toBe(
      "2 Empty\nBody.",
    );
  });

  it("reports duplicated whole schedules", async () => {
    const xml =
      '<act><body/><schedule.group><schedule deletion-status="repealed"><label>21</label><heading>Old</heading></schedule><schedule><label>21</label><heading>Current</heading></schedule></schedule.group></act>';
    const doc = await readLegislation(chunked(xml), { target: { schedule: "21" } });
    expect(doc.matches.map((m) => m.entry.repealed)).toEqual([true, false]);
    expect(doc.text).toBe("21 Current");
  });
});
