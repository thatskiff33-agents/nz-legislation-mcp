// End to end: build the real server, spawn it over stdio, and talk to it with the official client.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DUMMY_KEY } from "../dummy-key.js";

const ROOT = join(import.meta.dirname, "..", "..");
// Inside the repo so dist-relative paths (../package.json) resolve as in the published package.
const OUT = join(ROOT, ".e2e-dist");
const CLI = join(OUT, "cli.js");

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", join(ROOT, "tsconfig.build.json"), "--outDir", OUT], {
    stdio: "inherit",
  });
}, 60_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

describe("stdio binary", () => {
  it("speaks MCP over stdio and lists the tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: { LEGISLATION_NZ_API_KEY: DUMMY_KEY, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "search_legislation",
      "get_legislation",
      "list_versions",
      "get_table_of_contents",
      "get_provision_text",
      "compare_versions",
      "get_api_quota",
    ]);
    const quota = await client.callTool({ name: "get_api_quota", arguments: {} });
    expect(quota.structuredContent).toMatchObject({ known: false });
    await client.close();
  }, 30_000);

  it("serves a client pinned to the 2026-07-28 protocol revision", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: { LEGISLATION_NZ_API_KEY: DUMMY_KEY, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "e2e-modern", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);
    await client.close();
  }, 30_000);

  it("exits 1 with a readable message when no key is configured", () => {
    const run = spawnSync(process.execPath, [CLI], {
      env: { PATH: process.env["PATH"] ?? "", XDG_CONFIG_HOME: "/nonexistent-nzlm-test" },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("No API key found");
    expect(run.stdout).toBe(""); // stdout is reserved for the protocol
  });
});

describe("http binary", () => {
  it("serves MCP over HTTP on loopback", async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, [CLI, "http"], {
      env: {
        LEGISLATION_NZ_API_KEY: DUMMY_KEY,
        LEGISLATION_NZ_HTTP_PORT: String(port),
        PATH: process.env["PATH"] ?? "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let log = "";
        child.stderr.on("data", (d: Buffer) => {
          log += d.toString();
          if (log.includes('"message":"listening"')) resolve();
        });
        child.on("exit", (code) => {
          reject(new Error(`exited ${String(code)}: ${log}`));
        });
      });
      const client = new Client({ name: "e2e-http", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`)),
      );
      expect((await client.listTools()).tools).toHaveLength(7);
      await client.close();
      const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);

  it("refuses to start remotely without OAuth", () => {
    const run = spawnSync(process.execPath, [CLI, "http"], {
      env: {
        LEGISLATION_NZ_API_KEY: DUMMY_KEY,
        LEGISLATION_NZ_HTTP_HOST: "0.0.0.0",
        PATH: process.env["PATH"] ?? "",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Remote HTTP mode requires OAuth");
  });
});
