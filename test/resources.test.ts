// Resource templates and prompts, through the official client over an in-memory transport.
import { Client, InMemoryTransport, ProtocolError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { ToolDeps } from "../src/tools/shared.js";
import { json, status, type Step } from "./api/fake-fetch.js";
import { bigAct, loadXml } from "./text/xml.js";
import { deps as makeDeps } from "./tools/harness.js";

const WORK = "act_public_1976_33";
const V2014 = `${WORK}_en_2014-01-01`;
const WAITANGI = loadXml("waitangi-day-act-1976.xml");
const record = (id: string, work = WORK) =>
  json({ work_id: work, version_id: id, title: "Waitangi Day Act 1976", formats: [] });

let client: Client | undefined;

async function connect(
  steps: Step[] = [],
  documents: Record<string, string> = { [V2014]: WAITANGI },
  override: Partial<ToolDeps> = {},
) {
  const { deps, fake } = makeDeps(steps, "2026-11-02", documents);
  const server = createServer({ ...deps, ...override });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, fake };
}

const textOf = (result: { contents: readonly object[] }): string => {
  const first = result.contents[0];
  return first !== undefined && "text" in first ? String(first.text) : "";
};

const promptText = (result: { messages: readonly { content: object }[] }): string => {
  const content = result.messages[0]?.content;
  return content !== undefined && "text" in content ? String(content.text) : "";
};

function silentLike(): ToolDeps["logger"] {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("resource templates", () => {
  it("are listed with fixed capabilities, and nothing is enumerated", async () => {
    const { client: c } = await connect();
    expect(c.getServerCapabilities()?.resources?.listChanged).not.toBe(true);
    const { resourceTemplates } = await c.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "legislation://version/{version_id}/contents",
      "legislation://version/{version_id}/section/{section}",
      "legislation://version/{version_id}/schedule/{schedule}",
    ]);
    expect(resourceTemplates.every((t) => t.mimeType === "text/markdown")).toBe(true);
    expect((await c.listResources()).resources).toEqual([]);
  });

  it("reads the table of contents of a version", async () => {
    const { client: c } = await connect([record(V2014)]);
    const uri = `legislation://version/${V2014}/contents`;
    const result = await c.readResource({ uri });
    expect(result.contents[0]).toMatchObject({ uri, mimeType: "text/markdown" });
    const text = textOf(result);
    expect(text).toContain("# Waitangi Day Act 1976: contents");
    expect(text).toContain("The whole document.");
    expect(text).not.toContain("document..");
    expect(text).toContain("- section 6A Relationship with Holidays Act 2003");
    expect(text).toContain("https://www.legislation.govt.nz/act/public/1976/33/en/2014-01-01/");
  });

  it("shows the summary of a large Act, with the tool's notes", async () => {
    const id = "act_public_2099_1_en_2099-01-01";
    const { client: c } = await connect([record(id, "act_public_2099_1")], {
      [id]: bigAct(4, 100),
    });
    const text = textOf(await c.readResource({ uri: `legislation://version/${id}/contents` }));
    expect(text).toContain("- part 1 Part 1");
    expect(text).toContain("  - subpart 1A Sub 1");
    expect(text).toContain("Pass part");
  });

  it("reads one section, and decodes percent-encoded labels", async () => {
    const { client: c } = await connect([record(V2014), record(V2014)]);
    const text = textOf(await c.readResource({ uri: `legislation://version/${V2014}/section/6A` }));
    expect(text).toContain(
      "# Waitangi Day Act 1976, section 6A: Relationship with Holidays Act 2003",
    );
    expect(text.trimEnd().endsWith("check the official version before relying on it.")).toBe(true);
    // "CA%201" is decoded to "CA 1": valid, but not in this Act, so it is "not found" (not an
    // invalid label), which proves it was decoded.
    const err = await c
      .readResource({ uri: `legislation://version/${V2014}/section/CA%201` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe(-32602);
    expect((err as ProtocolError).message).toContain('"CA 1"');
  });

  it("reads a schedule and points to the tool for long text", async () => {
    const long = "word ".repeat(12_000);
    const xml = `<act><cover><title>Long Act 2099</title></cover><body></body><schedule.group><schedule><label>1</label><heading>Rates</heading><schedule.provisions><para><text>${long}</text></para></schedule.provisions></schedule></schedule.group></act>`;
    const id = "act_public_2099_2_en_2099-01-01";
    const { client: c } = await connect([record(id, "act_public_2099_2")], { [id]: xml });
    const text = textOf(await c.readResource({ uri: `legislation://version/${id}/schedule/1` }));
    expect(text).toContain("schedule 1: Rates");
    expect(text).toMatch(
      /\[Text continues: \d+ more characters\. Use the get_provision_text tool with version_id act_public_2099_2_en_2099-01-01 and offset 50000\.\]/u,
    );
  });

  it("rejects invalid identifiers and encodings before any API call", async () => {
    const { client: c, fake } = await connect();
    for (const uri of [
      `legislation://version/${V2014}/section/%E0%A4%A`,
      "legislation://version/not-a-version/contents",
      `legislation://version/${V2014}/section/%3Cscript%3E`,
      `legislation://version/${V2014}/section/a%2Fb`,
      `legislation://version/${V2014}/schedule/%20`,
      `legislation://version/${V2014}/schedule/%201`,
      `legislation://version/%20${V2014}/contents`,
    ]) {
      const err = await c.readResource({ uri }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).message).toContain("Invalid resource URI");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("reports API errors safely, and hides unexpected ones", async () => {
    const { client: c } = await connect([status(404)]);
    const err = await c
      .readResource({ uri: `legislation://version/${V2014}/contents` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    // A missing version is "resource not found" (-32602 with the URI), not an internal error.
    expect((err as ProtocolError).code).toBe(-32602);
    expect((err as ProtocolError).data).toEqual({ uri: `legislation://version/${V2014}/contents` });
    expect((err as ProtocolError).message).not.toContain("dummy-key");

    const denied = await connect([status(401)]);
    const unauthorised = await denied.client
      .readResource({ uri: `legislation://version/${V2014}/contents` })
      .catch((e: unknown) => e);
    expect((unauthorised as ProtocolError).code).toBe(-32603);
    expect((unauthorised as ProtocolError).message).toContain("401");

    const logged: string[] = [];
    const broken = await connect(
      [record(V2014)],
      {},
      { logger: { ...silentLike(), error: (message: string) => logged.push(message) } },
    );
    const hidden = await broken.client
      .readResource({ uri: `legislation://version/${V2014}/contents` })
      .catch((e: unknown) => e);
    expect((hidden as ProtocolError).code).toBe(-32603);
    expect((hidden as ProtocolError).message).toContain("An unexpected error occurred");
    expect((hidden as ProtocolError).message).not.toContain("no XML fixture");
    expect(logged).toEqual(["unexpected resource failure"]);
  });
});

describe("resource formatting", () => {
  it("rewords tool-only advice when a label appears more than once", async () => {
    const id = "act_public_2099_3_en_2099-01-01";
    // The reader keeps scanning past a repealed match, so a repealed then a current section 1.
    const prov = (part: string) =>
      `<part><label>${part}</label><heading>Part ${part}</heading><prov${part === "1" ? ' deletion-status="repealed"' : ""}><label>1</label><heading>Rule ${part}</heading><prov.body><subprov><label/><para><text>Text ${part}.</text></para></subprov></prov.body></prov></part>`;
    const xml = `<act><cover><title>Twice Act 2099</title></cover><body>${prov("1")}${prov("2")}</body></act>`;
    const { client: c } = await connect([record(id, "act_public_2099_3")], { [id]: xml });
    const text = textOf(await c.readResource({ uri: `legislation://version/${id}/section/1` }));
    expect(text).toContain("This label appears 2 times");
    expect(text).toContain("use the get_provision_text tool with part and subpart");
    expect(text).not.toContain("Pass part (and subpart) to choose another.");
  });

  it("omits the permalink for agency-published records", async () => {
    const id = "secondary-legislation_agency-drafted_2026_~346217_en_2026-10-20";
    const work = "secondary-legislation_agency-drafted_2026_~346217";
    const { client: c } = await connect([record(id, work)], {
      [id]: "<act><cover><title>Agency Notice 2026</title></cover><body></body></act>",
    });
    const text = textOf(await c.readResource({ uri: `legislation://version/${id}/contents` }));
    expect(text).toContain(`Version ${id}. The whole document.`);
  });
});

describe("prompts", () => {
  it("lists two prompts with typed arguments", async () => {
    const { client: c } = await connect();
    expect(c.getServerCapabilities()?.prompts?.listChanged).not.toBe(true);
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => [p.name, p.arguments?.map((a) => [a.name, a.required])])).toEqual([
      [
        "find_provision",
        [
          ["topic", true],
          ["legislation", false],
          ["as_at", false],
        ],
      ],
      [
        "what_changed",
        [
          ["legislation", true],
          ["since", true],
          ["provision", false],
        ],
      ],
    ]);
  });

  it("builds the find_provision request", async () => {
    const { client: c } = await connect();
    const text = promptText(
      await c.getPrompt({ name: "find_provision", arguments: { topic: "tax" } }),
    );
    expect(text).toContain('deals with this topic: "tax".');
    expect(text).toContain("as at today");
    expect(text).toContain("search content if a title search finds nothing");
    expect(text).toContain("not legal advice");

    const full = promptText(
      await c.getPrompt({
        name: "find_provision",
        arguments: { topic: 'say "hi"', legislation: "Income Tax Act 2007", as_at: "2020-04-01" },
      }),
    );
    expect(full).toContain(`"say 'hi'"`);
    expect(full).toContain('Look in this legislation: "Income Tax Act 2007".');
    expect(full).toContain("with that work_id and as_at 2020-04-01");
  });

  it("builds the what_changed request", async () => {
    const { client: c } = await connect();
    const whole = promptText(
      await c.getPrompt({
        name: "what_changed",
        arguments: { legislation: "Goods and Services Tax Act 1985", since: "2024-04-01" },
      }),
    );
    expect(whole).toContain('changed in "Goods and Services Tax Act 1985" since 2024-04-01.');
    expect(whole).toContain("Pick the provisions that matter");
    const one = promptText(
      await c.getPrompt({
        name: "what_changed",
        arguments: { legislation: "GST Act", since: "2024-04-01", provision: "section 8" },
      }),
    );
    expect(one).toContain('in "section 8".');
    expect(one).toContain("compare_versions for that provision, from_as_at 2024-04-01");
  });

  it("names only tools and arguments that exist", async () => {
    const { client: c } = await connect();
    const { tools } = await c.listTools();
    const names = new Set(tools.map((t) => t.name));
    const args = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));
    const texts = [
      promptText(
        await c.getPrompt({
          name: "find_provision",
          arguments: { topic: "tax", legislation: "Income Tax Act 2007", as_at: "2020-04-01" },
        }),
      ),
      promptText(
        await c.getPrompt({
          name: "what_changed",
          arguments: { legislation: "GST Act", since: "2024-04-01", provision: "section 8" },
        }),
      ),
      promptText(
        await c.getPrompt({
          name: "what_changed",
          arguments: { legislation: "GST Act", since: "2024-04-01" },
        }),
      ),
    ].join("\n");
    // Every snake_case word is a tool name or a tool argument.
    const words = [...texts.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)].map((m) => m[0]);
    expect(words.length).toBeGreaterThan(5);
    expect(words.filter((w) => !names.has(w) && !args.has(w))).toEqual([]);
  });

  it("rejects bad arguments", async () => {
    const { client: c } = await connect();
    for (const args of [
      { topic: "a\u2028b" },
      { topic: "" },
      { topic: "a\u0007b" },
      { topic: "x".repeat(201) },
      { topic: "tax", as_at: "1 April 2020" },
    ]) {
      await expect(c.getPrompt({ name: "find_provision", arguments: args })).rejects.toThrow();
    }
    await expect(
      c.getPrompt({ name: "what_changed", arguments: { legislation: "GST Act" } }),
    ).rejects.toThrow();
  });
});
