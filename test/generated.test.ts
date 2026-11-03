// Generated files must match their source of truth. To regenerate after a change: pnpm generate
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { SHORT_DESCRIPTION, generatedFiles } from "../scripts/distribution.js";

const ROOT = join(import.meta.dirname, "..");

describe("generated files", () => {
  it.each(Object.entries(generatedFiles()))("%s is up to date", async (path, content) => {
    const file = join(ROOT, path);
    // Markdown is Prettier-formatted; JSON is kept exactly as generated (see .prettierignore).
    const expected = path.endsWith(".md")
      ? await format(content, { ...((await resolveConfig(file)) ?? {}), filepath: file })
      : content;
    await expect(expected).toMatchFileSnapshot(file);
  });

  it("keeps the registry description within 100 characters", () => {
    expect(SHORT_DESCRIPTION.length).toBeLessThanOrEqual(100);
  });
});

describe("release-please", () => {
  const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  const pkg = read("package.json") as { version: string };
  const config = read("release-please-config.json") as {
    packages: { ".": { "extra-files": { path: string; jsonpath: string }[] } };
  };
  const bumped = new Set(config.packages["."]["extra-files"].map((f) => `${f.path} ${f.jsonpath}`));

  /** JSONPaths of every string equal to the package version. */
  function versionPaths(value: unknown, path = "$"): string[] {
    if (value === pkg.version) return [path];
    if (Array.isArray(value))
      return value.flatMap((item, i) => versionPaths(item, `${path}[${String(i)}]`));
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, item]) => versionPaths(item, `${path}.${key}`));
    }
    return [];
  }

  it("bumps every version field in the generated files", () => {
    const found = Object.entries(generatedFiles())
      .filter(([path]) => path.endsWith(".json"))
      .flatMap(([path, content]) => versionPaths(JSON.parse(content)).map((p) => `${path} ${p}`));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((entry) => !bumped.has(entry))).toEqual([]);
  });

  it("pins the plugin to the package version (scripts/sync-release-files.mjs agrees)", () => {
    const result = spawnSync(process.execPath, ["scripts/sync-release-files.mjs", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const mcp = JSON.parse(generatedFiles()["plugins/nz-legislation-mcp/.mcp.json"] ?? "{}") as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(mcp.mcpServers["nz-legislation"]?.args).toContain(`nz-legislation-mcp@${pkg.version}`);
  });

  it("tracks the package.json version", () => {
    expect(read(".release-please-manifest.json")).toEqual({ ".": pkg.version });
  });
});
