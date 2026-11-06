// Documentation drift checks: the docs must describe every setting the code reads.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV } from "../src/config.js";
import { HTTP_ENV } from "../src/http/config.js";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("docs/self-hosting.md", () => {
  const guide = read("docs/self-hosting.md");
  const table = guide.slice(
    guide.indexOf("## Configuration"),
    guide.indexOf("## Choosing a provider"),
  );

  it.each([...Object.values(ENV), ...Object.values(HTTP_ENV)])(
    "documents %s in the configuration table",
    (name) => {
      expect(table).toMatch(new RegExp(`\\|\\s*\`${name}\`\\s*\\|`, "u"));
    },
  );

  it("documents no setting that the code does not read", () => {
    const known = new Set<string>([...Object.values(ENV), ...Object.values(HTTP_ENV)]);
    const documented = [...table.matchAll(/\|\s*`(LEGISLATION_NZ_[A-Z_]+)`\s*\|/gu)].map(
      (m) => m[1],
    );
    expect(documented.filter((name) => !known.has(String(name)))).toEqual([]);
  });
});

describe("deploy/", () => {
  it("uses only settings the code reads", () => {
    const files = read("deploy/docker-compose.yml") + read("deploy/.env.example");
    const known = new Set<string>([...Object.values(ENV), ...Object.values(HTTP_ENV)]);
    const used = [...files.matchAll(/(LEGISLATION_NZ_[A-Z_]+)/gu)].map((m) => String(m[1]));
    expect(used.filter((name) => !known.has(name))).toEqual([]);
  });
});

/** Every text file the drift checks below read: the docs and the source that cites them. */
function citingFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, extension: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path, extension);
      else if (entry.name.endsWith(extension)) out.push(path);
    }
  };
  walk("src", ".ts");
  walk("scripts", ".ts");
  walk("docs", ".md");
  out.push(...readdirSync(ROOT).filter((name) => name.endsWith(".md")));
  out.push("spec/README.md");
  return out;
}

describe("paths and commands cited in docs and source", () => {
  const files = citingFiles();

  it("cite only repository paths that exist", () => {
    const pattern =
      /(?<![\w./-])((?:src|docs|test|scripts|spec|deploy|packaging|plugins|\.github)\/[\w./-]*[\w-]\.(?:ts|mjs|md|json|ya?ml|sh|toml|html))(?![\w/*<])/gu;
    const missing = files.flatMap((file) =>
      [...read(file).matchAll(pattern)]
        .map((m) => String(m[1]))
        .filter((path) => !existsSync(join(ROOT, path)))
        .map((path) => `${file}: ${path}`),
    );
    expect(missing).toEqual([]);
  });

  it("mention only pnpm scripts that exist", () => {
    const scripts = new Set(
      Object.keys(
        (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts,
      ),
    );
    // pnpm's own commands, which are not package scripts.
    const builtIn = new Set(["install", "add", "audit", "pack", "exec", "dlx", "run", "why"]);
    const unknown = files.flatMap((file) =>
      // Commands only: in backticks or quotes, or at the start of a line (code blocks).
      [...read(file).matchAll(/(?:^|[`"]|\$ )pnpm (?:run )?([a-z][\w:-]*)/gmu)]
        .map((m) => String(m[1]))
        .filter((name) => !scripts.has(name) && !builtIn.has(name))
        .map((name) => `${file}: pnpm ${name}`),
    );
    expect(unknown).toEqual([]);
  });
});
