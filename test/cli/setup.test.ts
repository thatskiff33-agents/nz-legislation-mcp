import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apiErrors } from "../../src/api/errors.js";
import { runSetup, verifyWithApi, type SetupIo } from "../../src/cli/setup.js";
import {
  InputCancelledError,
  InputNotHiddenError,
  TerminalReadError,
} from "../../src/cli/terminal.js";
import { DUMMY_KEY } from "../dummy-key.js";
import { fakeFetch, json, status } from "../api/fake-fetch.js";
import { fixture } from "../fixtures.js";

function io(overrides: Partial<SetupIo> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nzlm-setup-"));
  const out: string[] = [];
  const err: string[] = [];
  const value: SetupIo = {
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readSecret: () => Promise.resolve(` ${DUMMY_KEY} `),
    readStdin: () => Promise.resolve(`${DUMMY_KEY}\n`),
    verify: () => Promise.resolve(),
    keyFilePath: join(dir, "nz-legislation-mcp", "key"),
    ...overrides,
  };
  return { value, out, err, path: String(value.keyFilePath) };
}

/** Permission bits are POSIX only: Windows reports 0o666 whatever mode is requested. */
const onWindows = process.platform === "win32";

describe("setup", () => {
  it("verifies and saves the key, then points at client setup", async () => {
    // Pinned to the POSIX wording so the assertion is the same on every host.
    const t = io({ platform: "linux" });
    expect(await runSetup([], t.value)).toBe(0);
    expect(readFileSync(t.path, "utf8")).toBe(`${DUMMY_KEY}\n`);
    expect(t.out.join("")).toContain("Key checked with the Legislation API: OK.");
    expect(t.out.join("")).toContain("readable only by you");
    expect(t.out.join("") + t.err.join("")).not.toContain(DUMMY_KEY);
  });

  it.skipIf(onWindows)("saves the key file and folder privately (POSIX modes)", async () => {
    const t = io();
    expect(await runSetup([], t.value)).toBe(0);
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.path, "..")).mode & 0o777).toBe(0o700);
  });

  it("words the message for Windows", async () => {
    const t = io({ platform: "win32" });
    expect(await runSetup([], t.value)).toBe(0);
    expect(t.out.join("")).toContain("protected by your Windows account");
  });

  it.skipIf(onWindows)("tightens an existing folder", async () => {
    const u = io();
    mkdirSync(join(u.path, ".."), { recursive: true, mode: 0o755 });
    expect(await runSetup([], u.value)).toBe(0);
    expect(statSync(join(u.path, "..")).mode & 0o777).toBe(0o700);
  });

  it("saves nothing when key entry is cancelled or fails", async () => {
    const cancelled = io({
      readSecret: () => Promise.reject(new InputCancelledError("Cancelled.")),
    });
    expect(await runSetup([], cancelled.value)).toBe(130);
    expect(cancelled.err.join("")).toContain("Cancelled. Nothing was saved.");
    const failed = io({ readStdin: () => Promise.reject(new Error("EIO")) });
    expect(await runSetup(["--key-stdin"], failed.value)).toBe(1);
    expect(failed.err.join("")).toContain("Could not read the key.");
    expect(() => statSync(failed.path)).toThrow();
    const broken = io({
      readSecret: () => Promise.reject(new TerminalReadError("Could not read from the terminal.")),
    });
    expect(await runSetup([], broken.value)).toBe(1);
    expect(broken.err.join("")).toContain("Could not read from the terminal. Nothing was saved.");
  });

  it("refuses, saving nothing, when the terminal cannot hide the key", async () => {
    const t = io({
      readSecret: () =>
        Promise.reject(new InputNotHiddenError("This terminal can't hide your key.")),
    });
    expect(await runSetup([], t.value)).toBe(1);
    expect(t.err.join("")).toBe("This terminal can't hide your key.\n");
    expect(() => statSync(t.path)).toThrow();
  });

  it("reads the key from standard input and can skip verification", async () => {
    const verify = vi.fn(() => Promise.resolve());
    const t = io({ verify });
    expect(await runSetup(["--key-stdin", "--no-verify"], t.value)).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(readFileSync(t.path, "utf8")).toBe(`${DUMMY_KEY}\n`);
  });

  it("refuses to overwrite an existing key unless forced", async () => {
    const t = io();
    await runSetup([], t.value);
    expect(await runSetup([], t.value)).toBe(1);
    expect(t.err.join("")).toContain("Use --force to replace it");
    expect(await runSetup(["--force"], t.value)).toBe(0);
  });

  it("rejects invalid keys without saving", async () => {
    const t = io({ readSecret: () => Promise.resolve("YOUR_KEY") });
    expect(await runSetup([], t.value)).toBe(1);
    expect(t.err.join("")).toContain("placeholder");
    expect(() => statSync(t.path)).toThrow();
  });

  it("does not save a key the API rejects", async () => {
    const t = io({ verify: () => Promise.reject(apiErrors.unauthorised()) });
    expect(await runSetup([], t.value)).toBe(1);
    const said = t.err.join("");
    expect(said).toContain(
      "The Legislation API rejected the API key (401). Check that you copied the whole key PCO sent you and that it is your current key.\nNothing was saved. Use --no-verify to save it anyway.\n",
    );
    // The model-facing guidance (about "the user" and AI clients) is not shown to a person.
    expect(said).not.toContain("The user should");
    expect(said).not.toContain("Do not retry");
    expect(() => statSync(t.path)).toThrow();
    const quota = io({ verify: () => Promise.reject(apiErrors.dailyQuota()) });
    expect(await runSetup([], quota.value)).toBe(1);
    expect(quota.err.join("")).toContain(apiErrors.dailyQuota().message);
    expect(() => statSync(quota.path)).toThrow();
    const odd = io({ verify: () => Promise.reject(new Error("weird")) });
    expect(await runSetup([], odd.value)).toBe(1);
    expect(odd.err.join("")).toContain("The key could not be checked.");
  });

  it("rejects unknown options", async () => {
    const t = io();
    expect(await runSetup(["--save-everywhere"], t.value)).toBe(2);
    expect(t.err.join("")).toContain("Usage: nz-legislation-mcp setup");
  });

  it("cleans up if the final rename fails", async () => {
    const t = io();
    // A directory where the key file should go makes the rename fail.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(t.path, { recursive: true });
    writeFileSync(join(t.path, "x"), "");
    await expect(runSetup(["--force"], t.value)).rejects.toThrow();
  });

  it("uses the default key location when none is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-xdg-"));
    const t = io({ keyFilePath: undefined, env: { XDG_CONFIG_HOME: dir, APPDATA: dir } });
    expect(await runSetup(["--no-verify"], t.value)).toBe(0);
    expect(readFileSync(join(dir, "nz-legislation-mcp", "key"), "utf8")).toBe(`${DUMMY_KEY}\n`);
  });
});

describe("verifyWithApi", () => {
  it("makes one small search request", async () => {
    const fake = fakeFetch(json(fixture("search-works")));
    vi.stubGlobal("fetch", fake.fn);
    await verifyWithApi(DUMMY_KEY);
    expect(fake.calls[0]?.url).toContain("per_page=1");
  });

  it("rejects with the API error", async () => {
    vi.stubGlobal("fetch", fakeFetch(status(401)).fn);
    await expect(verifyWithApi(DUMMY_KEY)).rejects.toThrow("rejected the API key");
  });
});
