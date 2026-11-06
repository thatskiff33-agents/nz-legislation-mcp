import { DUMMY_KEY } from "./dummy-key.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { ConfigError, defaultKeyFilePath, ENV, keyFileProblem, loadConfig } from "../src/config.js";

const KEY = DUMMY_KEY;
/**
 * Real file-system cases that need POSIX features (permission bits, /dev/null, mkfifo). They are
 * skipped on Windows; the rules themselves are covered on every platform through keyFileProblem.
 */
const onWindows = process.platform === "win32";
/** A reader with no files at all: missing when allowed, otherwise unreadable. */
const noFile = (_path: string, options?: { allowMissing: boolean }): string | undefined => {
  if (options?.allowMissing === true) return undefined;
  throw new Error("no file");
};

function problems(
  env: Record<string, string>,
  reader: Parameters<typeof loadConfig>[1] = noFile,
): string[] {
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
    expect(c.keySource).toBe(`the environment variable ${ENV.apiKey}`);
    expect(c).toMatchObject({ timeoutMs: 15_000, cache: "off", logLevel: "info" });
  });

  it("loads a key from a file (secrets pattern)", () => {
    const c = loadConfig({ [ENV.apiKeyFile]: "/run/secrets/key" }, (p) =>
      p === "/run/secrets/key" ? `${KEY}\r\n` : "",
    );
    expect(c.apiKey.reveal()).toBe(KEY);
    expect(c.keySource).toBe(`the file named by ${ENV.apiKeyFile} (/run/secrets/key)`);
  });

  it("uses the real file system by default", () => {
    expect(() => loadConfig({ [ENV.apiKeyFile]: "/definitely/not/a/real/path" })).toThrow(
      `${ENV.apiKeyFile} points to a file that cannot be read.`,
    );
  });

  describe("default key file (written by setup)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-default-"));
    const path = join(dir, "key");

    it("is used when no key variable is set", () => {
      writeFileSync(path, `${KEY}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      const c = loadConfig({}, undefined, path);
      expect(c.apiKey.reveal()).toBe(KEY);
      expect(c.keySource).toBe(`the key file saved by setup (${path})`);
      expect(c.keySource).not.toContain(KEY);
    });

    // POSIX only: Windows ignores chmod permission bits.
    it.skipIf(onWindows)("is refused if other users can read it", () => {
      writeFileSync(path, `${KEY}\n`);
      chmodSync(path, 0o644);
      expect(() => loadConfig({}, undefined, path)).toThrow(
        `can be read by other users; run: chmod 600 ${path}`,
      );
    });

    it("reports an invalid key in the file", () => {
      writeFileSync(path, "YOUR_KEY\n");
      chmodSync(path, 0o600);
      expect(() => loadConfig({}, undefined, path)).toThrow(
        `The key file ${path} contains placeholder text`,
      );
    });

    it("suggests setup when the file does not exist", () => {
      expect(() => loadConfig({}, undefined, join(dir, "missing"))).toThrow(
        'Run "npx nz-legislation-mcp setup"',
      );
    });

    it("reports other read problems", () => {
      expect(() => loadConfig({}, undefined, dir)).toThrow(
        `The key file ${dir} is not a regular file`,
      );
      expect(problems({})).toEqual([
        'No API key found. Run "npx nz-legislation-mcp setup", or set LEGISLATION_NZ_API_KEY (request a key by email to contact@pco.govt.nz).',
      ]);
      const throwing = () => {
        throw new Error("boom");
      };
      expect(() => loadConfig({}, throwing, path)).toThrow(`The key file ${path} cannot be read`);
    });

    it("lives in the user's config directory on each platform", () => {
      expect(defaultKeyFilePath({}, "linux", "/home/u")).toBe(
        "/home/u/.config/nz-legislation-mcp/key",
      );
      expect(defaultKeyFilePath({ XDG_CONFIG_HOME: "/x" }, "darwin", "/Users/u")).toBe(
        "/x/nz-legislation-mcp/key",
      );
      expect(
        defaultKeyFilePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
      ).toContain("nz-legislation-mcp");
      expect(defaultKeyFilePath({}, "win32", "/h")).toContain("AppData");
      expect(typeof defaultKeyFilePath()).toBe("string");
    });

    it("ignores empty or relative config directories (never the current directory)", () => {
      for (const XDG_CONFIG_HOME of ["", "relative/dir"]) {
        expect(defaultKeyFilePath({ XDG_CONFIG_HOME }, "linux", "/home/u")).toBe(
          "/home/u/.config/nz-legislation-mcp/key",
        );
      }
      expect(defaultKeyFilePath({ APPDATA: "" }, "win32", "/h")).toContain("AppData");
      expect(defaultKeyFilePath({ APPDATA: "rel" }, "win32", "/h")).toContain("AppData");
    });
  });

  describe("key file rules (any platform)", () => {
    const file = (mode: number) => ({ isFile: () => true, mode });

    it("refuses anything that is not a regular file", () => {
      expect(keyFileProblem({ isFile: () => false, mode: 0o600 }, "/k", false, "linux")).toBe(
        "is not a regular file",
      );
    });

    it("refuses a default key file that group or others can read, except on Windows", () => {
      expect(keyFileProblem(file(0o644), "/k", true, "linux")).toBe(
        "can be read by other users; run: chmod 600 /k",
      );
      expect(keyFileProblem(file(0o640), "/k", true, "darwin")).toContain("other users");
      expect(keyFileProblem(file(0o600), "/k", true, "linux")).toBeUndefined();
      expect(keyFileProblem(file(0o666), "C:\\k", true, "win32")).toBeUndefined();
    });

    it("does not apply the private-mode rule to an operator-named file", () => {
      expect(keyFileProblem(file(0o644), "/run/secrets/key", false, "linux")).toBeUndefined();
    });

    it("uses the current platform by default", () => {
      expect(keyFileProblem(file(0o644), "/k", true)).toBe(
        keyFileProblem(file(0o644), "/k", true, process.platform),
      );
    });
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

    // POSIX only: Windows has no /dev/null path and no mkfifo.
    it.skipIf(onWindows)("refuses a device such as /dev/null", () => {
      expect(() => loadConfig({ [ENV.apiKeyFile]: "/dev/null" })).toThrow("is not a regular file");
    });

    it.skipIf(onWindows)("refuses a FIFO without blocking", () => {
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
    [{}, 'No API key found. Run "npx nz-legislation-mcp setup"'],
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
    [{ [ENV.apiKey]: "back\\slashkeyvalue" }, "backslashes"],
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
