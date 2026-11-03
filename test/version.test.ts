import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_AGENT, VERSION, versionFromPackageJson } from "../src/version.js";

describe("version", () => {
  it("matches package.json (single source of truth)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(
      `nz-legislation-mcp/${pkg.version} (+https://github.com/thatskiff33-agents/nz-legislation-mcp)`,
    );
  });

  it("falls back when the version is missing", () => {
    expect(versionFromPackageJson("{}")).toBe("0.0.0");
  });
});
