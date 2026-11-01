import { DUMMY_KEY } from "./dummy-key.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, ENV, loadConfig } from "../src/config.js";

const KEY = DUMMY_KEY;
const noFile = (): string => {
  throw new Error("no file");
};

function problems(env: Record<string, string>, reader: (p: string) => string = noFile): string[] {
  try {
    loadConfig(env, reader);
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
  return [];
}

describe("loadConfig", () => {
  it("loads a key from the environment with safe defaults", () => {
    const c = loadConfig({ [ENV.apiKey]: `  ${KEY}\n` }, noFile);
    expect(c.apiKey.reveal()).toBe(KEY);
    expect(c).toMatchObject({ timeoutMs: 15_000, cache: "off", logLevel: "info" });
  });

  it("loads a key from a file (secrets pattern)", () => {
    const c = loadConfig({ [ENV.apiKeyFile]: "/run/secrets/key" }, (p) =>
      p === "/run/secrets/key" ? `${KEY}\r\n` : "",
    );
    expect(c.apiKey.reveal()).toBe(KEY);
  });

  it("uses the real file system by default", () => {
    expect(() => loadConfig({ [ENV.apiKeyFile]: "/definitely/not/a/real/path" })).toThrow(
      `${ENV.apiKeyFile} points to a file that cannot be read.`,
    );
  });

  describe("key file safety (real file system)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-config-"));

    it("reads a small regular file", () => {
      const path = join(dir, "key");
      writeFileSync(path, `${KEY}\n`);
      expect(loadConfig({ [ENV.apiKeyFile]: path }).apiKey.reveal()).toBe(KEY);
    });

    it("refuses a directory", () => {
      const path = join(dir, "sub");
      mkdirSync(path);
      expect(() => loadConfig({ [ENV.apiKeyFile]: path })).toThrow("is not a regular file");
    });

    it("refuses a device such as /dev/null", () => {
      expect(() => loadConfig({ [ENV.apiKeyFile]: "/dev/null" })).toThrow("is not a regular file");
    });

    it("refuses a FIFO without blocking", () => {
      const path = join(dir, "fifo");
      execFileSync("mkfifo", [path]);
      expect(() => loadConfig({ [ENV.apiKeyFile]: path })).toThrow("is not a regular file");
    });

    it("refuses an oversized file", () => {
      const path = join(dir, "big");
      writeFileSync(path, "a".repeat(5000));
      expect(() => loadConfig({ [ENV.apiKeyFile]: path })).toThrow("is larger than 4096 bytes");
    });
  });

  it("reads options", () => {
    const c = loadConfig(
      {
        [ENV.apiKey]: KEY,
        [ENV.timeoutMs]: "5000",
        [ENV.cache]: "memory",
        [ENV.logLevel]: "debug",
      },
      noFile,
    );
    expect(c).toMatchObject({ timeoutMs: 5000, cache: "memory", logLevel: "debug" });
  });

  it("treats empty option values as unset", () => {
    expect(loadConfig({ [ENV.apiKey]: KEY, [ENV.timeoutMs]: "" }, noFile).timeoutMs).toBe(15_000);
  });

  it.each([
    [{}, "No API key found"],
    [{ [ENV.apiKey]: "" }, "No API key found"],
    [{ [ENV.apiKey]: "   " }, "is empty"],
    [{ [ENV.apiKey]: "YOUR_KEY" }, "placeholder"],
    [{ [ENV.apiKey]: "your_api_key_here" }, "placeholder"],
    [{ [ENV.apiKey]: "${LEGISLATION_NZ_API_KEY}" }, "unexpanded variable"],
    [{ [ENV.apiKey]: "$LEGISLATION_NZ_API_KEY" }, "unexpanded variable"],
    [{ [ENV.apiKey]: "<your-api-key>" }, "placeholder"],
    [{ [ENV.apiKey]: "$legislation_nz_api_key" }, "unexpanded variable"],
    [{ [ENV.apiKey]: "%LEGISLATION_NZ_API_KEY%" }, "unexpanded variable"],
    [{ [ENV.apiKey]: "short" }, "8 to 512 characters"],
    [{ [ENV.apiKey]: "has space in key value" }, "spaces, quotes"],
    [{ [ENV.apiKey]: '"quotedkeyvalue"' }, "spaces, quotes"],
    [{ [ENV.apiKey]: KEY, [ENV.apiKeyFile]: "/x" }, "Set only one"],
    [{ [ENV.apiKey]: KEY, [ENV.timeoutMs]: "10" }, `${ENV.timeoutMs} is invalid`],
    [{ [ENV.apiKey]: KEY, [ENV.cache]: "disk" }, `${ENV.cache} is invalid`],
    [{ [ENV.apiKey]: KEY, [ENV.logLevel]: "verbose" }, `${ENV.logLevel} is invalid`],
  ])("reports a clear problem for %j", (env, message) => {
    expect(problems(env).join("\n")).toContain(message);
  });

  it("reports an unreadable key file from any reader", () => {
    expect(problems({ [ENV.apiKeyFile]: "/x" })).toEqual([
      `${ENV.apiKeyFile} points to a file that cannot be read.`,
    ]);
  });

  it("reports an invalid key read from a file", () => {
    expect(problems({ [ENV.apiKeyFile]: "/k" }, () => "YOUR_KEY")[0]).toContain(
      `file named by ${ENV.apiKeyFile}`,
    );
  });

  it("collects several problems at once", () => {
    expect(problems({ [ENV.timeoutMs]: "x", [ENV.cache]: "disk" })).toHaveLength(3);
  });

  it("never includes key material in errors or inspected config", () => {
    const bad = "bad key with spaces 0123456789";
    let message = "";
    try {
      loadConfig({ [ENV.apiKey]: bad }, noFile);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("Invalid configuration");
    expect(message).not.toContain(bad);
    const c = loadConfig({ [ENV.apiKey]: KEY }, noFile);
    expect(JSON.stringify(c) + inspect(c, { depth: 10 })).not.toContain(KEY);
  });
});
