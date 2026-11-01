// Builds ToolDeps backed by a scripted fetch, for tool and server tests.
import { DUMMY_KEY } from "../dummy-key.js";
import { LegislationClient } from "../../src/api/client.js";
import { silentLogger } from "../../src/logger.js";
import { Secret } from "../../src/secret.js";
import type { ToolDeps } from "../../src/tools/shared.js";
import { fakeFetch, type FakeFetch, type Step } from "../api/fake-fetch.js";

export const TEST_KEY = DUMMY_KEY;

export function deps(steps: Step[], today = "2026-11-02"): { deps: ToolDeps; fake: FakeFetch } {
  const fake = fakeFetch(...steps);
  const client = new LegislationClient({
    apiKey: new Secret(TEST_KEY),
    timeoutMs: 5000,
    fetch: fake.fn,
    sleep: () => Promise.resolve(),
  });
  return { deps: { client, logger: silentLogger, today: () => today }, fake };
}

export const signal = new AbortController().signal;

/** A versions-list page built from version dates (newest first). */
export function versionsPage(
  workId: string,
  dates: string[],
  total = dates.length,
  page = 1,
): Record<string, unknown> {
  const [type, subtype, year, number] = workId.split("_");
  return {
    page,
    per_page: 100,
    total,
    results: dates.map((date) => ({
      work_id: workId,
      version_id: `${workId}_en_${date}`,
      title: "Example Act 2007",
      legislation_type: "act",
      legislation_status: "in_force",
      act_status: "in_force",
      act_type: subtype,
      administering_agencies: ["Inland Revenue Department"],
      formats: [
        {
          type: "html",
          url: `https://www.legislation.govt.nz/${String(type)}/${String(subtype)}/${String(year)}/${String(number)}/en/${date}/`,
        },
      ],
    })),
  };
}
