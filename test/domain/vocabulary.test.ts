// Drift check: every enum in the committed OpenAPI snapshot must match our vocabulary exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as vocab from "../../src/domain/vocabulary.js";

interface Param {
  name: string;
  schema?: { enum?: string[] };
}
interface Spec {
  paths: Record<string, { get: { parameters: Param[] } }>;
}

const spec = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "spec", "legislation-api-v0.openapi.json"),
    "utf8",
  ),
) as Spec;

function specEnum(path: string, name: string): string[] | undefined {
  return spec.paths[path]?.get.parameters.find((p) => p.name === name)?.schema?.enum;
}

describe("vocabulary matches the OpenAPI snapshot", () => {
  it.each([
    ["search_field", vocab.SEARCH_FIELDS],
    ["legislation_status", vocab.LEGISLATION_STATUSES],
    ["legislation_type", vocab.LEGISLATION_TYPES],
    ["act_type", vocab.ACT_TYPES],
    ["act_classification", vocab.CLASSIFICATIONS],
    ["act_status", vocab.ACT_STATUSES],
    ["instrument_type_group", vocab.INSTRUMENT_TYPE_GROUPS],
    ["instrument_status", vocab.INSTRUMENT_STATUSES],
    ["instrument_classification", vocab.CLASSIFICATIONS],
    ["bill_type", vocab.BILL_TYPES],
    ["bill_status", vocab.BILL_STATUSES],
    ["sort_by", vocab.SORT_ORDERS],
    ["publisher", vocab.PUBLISHERS],
  ])("/v0/works/ %s", (name, ours) => {
    expect([...ours].sort()).toEqual([...(specEnum("/v0/works/", name) ?? [])].sort());
  });

  it("covers every enum parameter in the spec", () => {
    const enumParams = spec.paths["/v0/works/"]?.get.parameters
      .filter((p) => p.schema?.enum)
      .map((p) => p.name);
    expect(enumParams?.sort()).toEqual(
      [
        "act_classification",
        "act_status",
        "act_type",
        "bill_status",
        "bill_type",
        "instrument_classification",
        "instrument_status",
        "instrument_type_group",
        "legislation_status",
        "legislation_type",
        "publisher",
        "search_field",
        "sort_by",
      ].sort(),
    );
  });

  it("assigns every type-specific filter to exactly one legislation type", () => {
    const all = Object.values(vocab.TYPE_SPECIFIC_FILTERS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("derived groups (issue #42)", () => {
  it("draw only on the vocabularies, so a renamed value cannot slip through", () => {
    const statuses = new Set<string>([
      ...vocab.ACT_STATUSES,
      ...vocab.INSTRUMENT_STATUSES,
      ...vocab.BILL_STATUSES,
    ]);
    for (const status of vocab.ENDED_STATUSES) expect(statuses.has(status), status).toBe(true);
    for (const type of vocab.STAGE_TYPES) {
      expect((vocab.LEGISLATION_TYPES as readonly string[]).includes(type), type).toBe(true);
    }
    expect((vocab.PUBLISHERS as readonly string[]).includes(vocab.AGENCY_PUBLISHER)).toBe(true);
    expect(vocab.API_LIMITS.defaultPerPage).toBeLessThanOrEqual(vocab.API_LIMITS.maxPerPage);
  });
});
