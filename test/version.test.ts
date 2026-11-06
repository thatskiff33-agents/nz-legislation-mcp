import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_NODE_MAJOR,
  packageInfo,
  REPOSITORY_SLUG,
  REPOSITORY_URL,
  USER_AGENT,
  VERSION,
} from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
};

describe("version and package facts", () => {
  it("come from package.json (single source of truth)", () => {
    expect(VERSION).toBe(pkg.version);
    expect(REPOSITORY_URL).toBe("https://github.com/thatskiff33/nz-legislation-mcp");
    expect(REPOSITORY_SLUG).toBe("thatskiff33/nz-legislation-mcp");
    expect(`>=${String(MIN_NODE_MAJOR)}`).toBe(pkg.engines.node);
    expect(USER_AGENT).toBe(`nz-legislation-mcp/${pkg.version} (+${REPOSITORY_URL})`);
  });

  const good = {
    repository: { url: "git+https://github.com/o/r.git" },
    engines: { node: ">= 24" },
  };

  it("falls back when the version is missing, and reads other forms", () => {
    expect(packageInfo(JSON.stringify(good))).toEqual({
      version: "0.0.0",
      repositoryUrl: "https://github.com/o/r",
      repositorySlug: "o/r",
      minNodeMajor: 24,
    });
  });

  it("refuses a package.json without a GitHub repository URL or engines.node", () => {
    expect(() => packageInfo(JSON.stringify({ ...good, repository: {} }))).toThrow(
      "repository.url",
    );
    expect(() =>
      packageInfo(JSON.stringify({ ...good, repository: { url: "https://gitlab.com/o/r" } })),
    ).toThrow("repository.url");
    expect(() => packageInfo(JSON.stringify({ ...good, engines: {} }))).toThrow("engines.node");
    expect(() => packageInfo(JSON.stringify({ ...good, engines: { node: "^22" } }))).toThrow(
      "engines.node",
    );
  });
});

describe("the repository URL is defined once (issue #42)", () => {
  /** Every .ts file under a directory. */
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return tsFiles(path);
      return name.endsWith(".ts") ? [path] : [];
    });
  }

  it("is not hard-coded in source or scripts, outside version.ts examples", () => {
    for (const file of [...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "scripts"))]) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line)) // comments may show examples
        .join("\n");
      expect(code, file).not.toContain("github.com/thatskiff33");
      expect(code, file).not.toContain('"thatskiff33');
    }
  });

  it("matches the container image's source label", () => {
    expect(readFileSync(join(ROOT, "Dockerfile"), "utf8")).toContain(
      `org.opencontainers.image.source="${REPOSITORY_URL}"`,
    );
  });
});
