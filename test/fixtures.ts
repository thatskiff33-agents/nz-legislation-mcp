// Loads recorded API responses from test/fixtures/api (sanitised, public data only).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "fixtures", "api");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as unknown;
}

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** Every work_id and version_id string that appears anywhere in the fixtures. */
export function allFixtureIds(): { workIds: string[]; versionIds: string[] } {
  const workIds = new Set<string>();
  const versionIds = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "work_id" && typeof v === "string") workIds.add(v);
        else if (k === "version_id" && typeof v === "string") versionIds.add(v);
        else walk(v);
      }
    }
  };
  fixtureNames().forEach((n) => {
    walk(fixture(n));
  });
  return { workIds: [...workIds], versionIds: [...versionIds] };
}
