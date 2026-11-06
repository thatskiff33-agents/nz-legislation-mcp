import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, status } from "./api/fake-fetch.js";
import { DUMMY_KEY } from "./dummy-key.js";
import { describe, expect, it, vi } from "vitest";
import { defaultIo, main, runCli, type MainIo } from "../src/main.js";

const KEY = DUMMY_KEY;

function io(env: Record<string, string>) {
  const stderr: string[] = [];
  const close = vi.fn(() => Promise.resolve());
  const factories: (() => unknown)[] = [];
  const serveOptions: { onerror?: (e: Error) => void }[] = [];
  const handlers = new Map<string, () => void>();
  const rejectionHandlers: ((reason: unknown) => void)[] = [];
  const value: MainIo = {
    env,
    stderr: (t) => stderr.push(t),
    stdout: (t) => stderr.push(t),
    stdin: process.stdin,
    serve: ((factory: () => unknown, options: { onerror?: (e: Error) => void }) => {
      factories.push(factory);
      serveOptions.push(options);
      return { close };
    }) as unknown as MainIo["serve"],
    onSignal: (signal, handler) => handlers.set(signal, handler),
    onUnhandledRejection: (handler) => rejectionHandlers.push(handler),
  };
  return { value, stderr, close, factories, handlers, serveOptions, rejectionHandlers };
}

describe("main", () => {
  it("exits with code 1 and a clear message when the key is missing", () => {
    const t = io({ XDG_CONFIG_HOME: "/nonexistent-nzlm-test", APPDATA: "/nonexistent-nzlm-test" });
    expect(main(t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("No API key found");
    expect(t.factories).toHaveLength(0);
  });

  it("serves over stdio, logs start-up without the key, and shuts down on signals", () => {
    const t = io({ LEGISLATION_NZ_API_KEY: KEY, LEGISLATION_NZ_CACHE: "memory" });
    expect(main(t.value)).toBeUndefined();
    expect(t.factories).toHaveLength(1);
    expect(t.factories[0]?.()).toBeTruthy(); // builds an McpServer
    const logged = t.stderr.join("");
    expect(logged).toContain('"message":"starting"');
    expect(logged).toContain('"cache":"memory"');
    expect(logged).not.toContain(KEY);
    t.handlers.get("SIGTERM")?.();
    expect(t.close).toHaveBeenCalledOnce();
    expect([...t.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("uses the process by default (no key in this test environment)", () => {
    vi.stubEnv("LEGISLATION_NZ_API_KEY", "");
    vi.stubEnv("LEGISLATION_NZ_API_KEY_FILE", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/nonexistent-nzlm-test");
    vi.stubEnv("APPDATA", "/nonexistent-nzlm-test");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main()).toBe(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("No API key found");
  });

  it("logs transport errors, unhandled rejections and shutdown failures (redacted)", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: KEY });
    t.close.mockImplementationOnce(() => Promise.reject(new Error(`close failed ${KEY}`)));
    main(t.value);
    t.serveOptions[0]?.onerror?.(new Error(`bad json ${KEY}`));
    t.rejectionHandlers[0]?.(new Error("stray rejection"));
    t.handlers.get("SIGINT")?.();
    await new Promise((resolve) => setImmediate(resolve));
    const logged = t.stderr.join("");
    expect(logged).toContain("stdio transport error");
    expect(logged).toContain("unhandled promise rejection");
    expect(logged).toContain("error while shutting down");
    expect(logged).not.toContain(KEY);
  });

  it("registers default process handlers", () => {
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    const handler = () => undefined;
    defaultIo.onUnhandledRejection(handler);
    expect(on).toHaveBeenCalledWith("unhandledRejection", handler);
  });

  it("registers default signal handlers on the process, once", () => {
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const handler = () => undefined;
    defaultIo.onSignal("SIGINT", handler);
    expect(once).toHaveBeenCalledWith("SIGINT", handler);
  });

  it("rethrows unexpected start-up errors", () => {
    const t = io({ LEGISLATION_NZ_API_KEY: KEY });
    const boom = {
      ...t.value,
      stderr: () => {
        throw new Error("stderr closed");
      },
    };
    expect(() => main(boom)).toThrow("stderr closed");
  });
});

describe("runCli", () => {
  it("prints the version and help", async () => {
    const t = io({});
    expect(await runCli(["--version"], t.value)).toBe(0);
    expect(await runCli(["-h"], t.value)).toBe(0);
    expect(t.stderr.join("")).toContain("Usage: nz-legislation-mcp [stdio|http|setup|doctor]");
  });

  it("rejects unknown commands and extra arguments with usage on stderr", async () => {
    const t = io({});
    expect(await runCli(["serve"], t.value)).toBe(2);
    expect(await runCli(["http", "extra"], t.value)).toBe(2);
  });

  it("runs stdio by default and http on request", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: KEY });
    expect(await runCli([], t.value)).toBeUndefined();
    expect(await runCli(["stdio"], t.value)).toBeUndefined();
    const http = vi.fn(() => Promise.resolve(7));
    expect(await runCli(["http"], t.value, http)).toBe(7);
  });

  it("loads the HTTP stack lazily by default", async () => {
    const t = io({ LEGISLATION_NZ_API_KEY: KEY, LEGISLATION_NZ_HTTP_HOST: "0.0.0.0" });
    expect(await runCli(["http"], t.value)).toBe(1); // config error: remote needs OAuth
    expect(t.stderr.join("")).toContain("Remote HTTP mode requires OAuth");
  });

  it("writes version output to stdout by default", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runCli(["--version"])).toBe(0);
    expect(spy).toHaveBeenCalled();
  });
});

describe("runCli setup and doctor", () => {
  const fakeStdin = (text: string, tty = false) => {
    const listeners = new Map<string, (chunk?: unknown) => void>();
    return {
      isTTY: tty,
      setRawMode: () => undefined,
      setEncoding: () => undefined,
      on: (event: string, listener: (chunk?: unknown) => void) => {
        listeners.set(event, listener);
      },
      removeAllListeners: () => undefined,
      pause: () => undefined,
      resume: () => {
        listeners.get("data")?.(text);
        listeners.get("end")?.();
      },
    };
  };

  it("runs setup from standard input and saves the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-cli-"));
    const t = io({ XDG_CONFIG_HOME: dir, APPDATA: dir });
    const value = { ...t.value, stdin: fakeStdin(`${KEY}\n`) };
    expect(await runCli(["setup", "--key-stdin", "--no-verify"], value)).toBe(0);
    expect(readFileSync(join(dir, "nz-legislation-mcp", "key"), "utf8")).toBe(`${KEY}\n`);
  });

  it("runs setup with a prompt and verifies against the API", async () => {
    vi.stubGlobal("fetch", fakeFetch(status(401)).fn);
    const dir = mkdtempSync(join(tmpdir(), "nzlm-cli-"));
    const t = io({ XDG_CONFIG_HOME: dir, APPDATA: dir });
    const value = { ...t.value, stdin: fakeStdin(`${KEY}\r`, true) };
    expect(await runCli(["setup"], value)).toBe(1);
    expect(t.stderr.join("")).toContain("rejected the API key");
  });

  it("refuses --key-stdin from an interactive terminal, saving nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-cli-"));
    const t = io({ XDG_CONFIG_HOME: dir, APPDATA: dir });
    const value = { ...t.value, stdin: fakeStdin(`${KEY}\n`, true) };
    expect(await runCli(["setup", "--key-stdin", "--no-verify"], value)).toBe(1);
    expect(t.stderr.join("")).toContain("--key-stdin is for piped input");
    expect(() => readFileSync(join(dir, "nz-legislation-mcp", "key"))).toThrow();
  });

  it("refuses to prompt when standard input cannot hide the key, saving nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nzlm-cli-"));
    const t = io({ XDG_CONFIG_HOME: dir, APPDATA: dir });
    const value = { ...t.value, stdin: fakeStdin(`${KEY}\n`, false) };
    expect(await runCli(["setup", "--no-verify"], value)).toBe(1);
    expect(t.stderr.join("")).toContain("This terminal can't hide your key.");
    expect(t.stderr.join("")).not.toContain("Paste your");
    expect(() => readFileSync(join(dir, "nz-legislation-mcp", "key"))).toThrow();
  });

  it("runs doctor", async () => {
    vi.stubGlobal("fetch", fakeFetch(() => new Response(null, { status: 200 })).fn);
    const t = io({ XDG_CONFIG_HOME: "/nonexistent-nzlm-test", APPDATA: "/nonexistent-nzlm-test" });
    expect(await runCli(["doctor"], t.value)).toBe(1);
    expect(t.stderr.join("")).toContain("[fail] Configuration");
  });

  it("rejects doctor with extra arguments", async () => {
    const t = io({});
    expect(await runCli(["doctor", "now"], t.value)).toBe(2);
  });
});
