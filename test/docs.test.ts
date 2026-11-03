// Documentation drift checks: the docs must describe every setting the code reads.
import { readFileSync } from "node:fs";
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
