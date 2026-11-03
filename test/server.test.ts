// The whole server in-process, through the official client over an in-memory transport.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import type { ToolDeps } from "../src/tools/shared.js";
import { VERSION } from "../src/version.js";
import { fixture } from "./fixtures.js";
import { json, status, type Step } from "./api/fake-fetch.js";
import { deps as makeDeps, TEST_KEY } from "./tools/harness.js";

let client: Client | undefined;

async function connect(steps: Step[], override: Partial<ToolDeps> = {}) {
  const { deps, fake } = makeDeps(steps);
  const server = createServer({ ...deps, ...override });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, fake };
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("server", () => {
  it("identifies itself and gives usage instructions", async () => {
    const { client: c } = await connect([]);
    expect(c.getServerVersion()).toMatchObject({ name: "nz-legislation-mcp", version: VERSION });
    expect(c.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("does not advertise tool list changes", async () => {
    const { client: c } = await connect([]);
    expect(c.getServerCapabilities()?.tools?.listChanged).not.toBe(true);
  });

  it("emits only regex patterns that every engine understands", async () => {
    const { client: c } = await connect([]);
    const { tools } = await c.listTools();
    const text = JSON.stringify(tools);
    expect(text).not.toContain("\\\\p{");
  });

  it("lists tools in a deterministic order with schemas and read-only annotations", async () => {
    const { client: c } = await connect([]);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "search_legislation",
      "get_legislation",
      "list_versions",
      "get_api_quota",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).not.toHaveProperty("anyOf");
      expect(tool.inputSchema).not.toHaveProperty("oneOf");
      expect(tool.outputSchema?.["type"]).toBe("object");
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description?.length).toBeGreaterThan(40);
    }
  });

  it("returns structured content plus the same JSON as text", async () => {
    const { client: c } = await connect([json(fixture("search-works"))]);
    const result = await c.callTool({
      name: "search_legislation",
      arguments: { search_term: "income tax" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ total: 241 });
  });

  it("turns API failures into actionable tool errors without the key", async () => {
    const { client: c } = await connect([status(401)]);
    const result = await c.callTool({
      name: "get_legislation",
      arguments: { version_id: "act_public_2007_97_en_2026-09-04" },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("rejected the API key");
    expect(text).not.toContain(TEST_KEY);
  });

  it("returns tool-level problems (e.g. no versions) as actionable errors", async () => {
    const { client: c } = await connect([json({ page: 1, per_page: 100, total: 0, results: [] })]);
    const result = await c.callTool({
      name: "get_legislation",
      arguments: { work_id: "act_public_2007_97" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "No versions were found for act_public_2007_97",
    );
  });

  it("reports invalid arguments as a tool error before calling the API", async () => {
    const { client: c, fake } = await connect([]);
    const result = await c.callTool({
      name: "search_legislation",
      arguments: { act_status: "in_force" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("act_status only applies");
    expect(fake.calls).toHaveLength(0);
  });

  it("hides unexpected internal errors behind a generic message", async () => {
    const lines: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => {
        lines.push(message);
      },
    };
    const broken = {
      today: () => {
        throw new Error("secret internal detail");
      },
    };
    const { client: c } = await connect([], { logger, ...broken });
    const result = await c.callTool({
      name: "get_legislation",
      arguments: { work_id: "act_public_2007_97" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unexpected error");
    expect(JSON.stringify(result.content)).not.toContain("secret internal detail");
    expect(lines).toContain("unexpected tool failure");
  });

  it("answers get_api_quota without calling the API", async () => {
    const { client: c, fake } = await connect([]);
    const result = await c.callTool({ name: "get_api_quota", arguments: {} });
    expect(result.structuredContent).toMatchObject({ known: false });
    expect(fake.calls).toHaveLength(0);
  });
});
