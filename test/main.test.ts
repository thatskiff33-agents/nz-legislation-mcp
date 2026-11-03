import { DUMMY_KEY } from "./dummy-key.js";
import { describe, expect, it, vi } from "vitest";
import { defaultIo, main, type MainIo } from "../src/main.js";

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
    const t = io({});
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
