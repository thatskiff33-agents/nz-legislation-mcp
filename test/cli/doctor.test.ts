import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import { DUMMY_KEY } from "../dummy-key.js";
import { fakeFetch, json, status } from "../api/fake-fetch.js";
import { fixture } from "../fixtures.js";

const NO_KEY = { XDG_CONFIG_HOME: "/nonexistent-nzlm-test", APPDATA: "/nonexistent-nzlm-test" };
const ok = () => () => new Response(null, { status: 200 });

async function doctor(
  env: Record<string, string>,
  steps: Parameters<typeof fakeFetch>,
  nodeVersion = "v22.20.0",
) {
  const out: string[] = [];
  const code = await runDoctor({
    env,
    stdout: (t) => out.push(t),
    nodeVersion,
    fetch: fakeFetch(...steps).fn,
  });
  return { code, text: out.join("") };
}

describe("doctor", () => {
  it("passes when everything is reachable, showing the quota", async () => {
    const r = await doctor({ LEGISLATION_NZ_API_KEY: DUMMY_KEY }, [
      json(fixture("search-works")),
      ok(),
    ]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("[ok] Legislation API: reachable; 9876 of 10000 requests left today");
    expect(r.text).toContain("[ok] legislation.govt.nz (for text): reachable");
    expect(r.text).toContain(
      "[ok] API key: found and well-formed, from the environment variable LEGISLATION_NZ_API_KEY",
    );
    expect(r.text).toContain("\nAll checks passed.\n");
    expect(r.text).not.toContain(DUMMY_KEY);
  });

  it("reports a missing key and an old Node.js", async () => {
    const r = await doctor(NO_KEY, [ok()], "v20.1.0");
    expect(r.code).toBe(1);
    expect(r.text).toContain("[fail] Node.js: v20.1.0 (version 22 or later is required)");
    expect(r.text).toContain(
      '[fail] Configuration: No API key found. Run "npx nz-legislation-mcp setup"',
    );
  });

  it("reports an API rejection and website problems", async () => {
    const rejected = await doctor({ LEGISLATION_NZ_API_KEY: DUMMY_KEY }, [
      status(401),
      () => new Response(null, { status: 503 }),
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.text).toContain(
      "[fail] Legislation API: The Legislation API rejected the API key",
    );
    expect(rejected.text).toContain("[warn] legislation.govt.nz (for text): HTTP 503");
    expect(rejected.text).toContain("\nSome required checks failed.\n");
    const offline = await doctor({ LEGISLATION_NZ_API_KEY: DUMMY_KEY }, [
      json(fixture("search-works"), 200, {}),
      new TypeError("offline"),
    ]);
    expect(offline.text).toContain("[ok] Legislation API: reachable\n");
    expect(offline.text).toContain("[warn] legislation.govt.nz (for text): not reachable");
    expect(offline.text).toContain("\nAll required checks passed, with warnings.\n");
    expect(offline.text).not.toContain("All checks passed.");
    expect(offline.code).toBe(0);
  });

  it("handles a network failure and an unparseable Node version", async () => {
    const r = await doctor(
      { LEGISLATION_NZ_API_KEY: DUMMY_KEY },
      [new TypeError("offline"), ok()],
      "unknown",
    );
    expect(r.text).toContain("[fail] Node.js: unknown");
    expect(r.text).toContain("[fail] Legislation API: Could not reach the Legislation API");
  });
});
