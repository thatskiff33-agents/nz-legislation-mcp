/**
 * Process entry logic for the stdio server: load config, wire dependencies, serve, and shut
 * down cleanly. Kept separate from cli.ts so it can be tested without spawning a process.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Input } from "./cli/terminal.js";
import { MemoryCache } from "./api/cache.js";
import { LegislationClient } from "./api/client.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { streamVersionXml } from "./text/xml-source.js";
import { todayInNewZealand, type ToolDeps } from "./tools/shared.js";
import { SERVER_NAME, VERSION } from "./version.js";

/** Bounded size of the optional response cache. */
const CACHE_MAX_ENTRIES = 500;
/** Bounded size of the optional rendered-text cache (entries can be large). */
const TEXT_CACHE_MAX_ENTRIES = 50;

export interface MainIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: (text: string) => void;
  /** Only for --version/--help/setup/doctor output, never while serving stdio (stdout is the protocol). */
  readonly stdout: (text: string) => void;
  /** Standard input, used only by `setup` (stdio serving reads it through the SDK). */
  readonly stdin: Input;
  readonly serve: typeof serveStdio;
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  readonly onUnhandledRejection: (handler: (reason: unknown) => void) => void;
}

/** @internal Exported for tests. */
export const defaultIo: MainIo = {
  env: process.env,
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
  stdin: process.stdin,
  serve: serveStdio,
  onSignal: (signal, handler) => process.once(signal, handler),
  onUnhandledRejection: (handler) => process.on("unhandledRejection", handler),
};

/**
 * Builds the dependencies shared by every tool call (stdio and HTTP mode).
 */
export function buildDeps(env: MainIo["env"], stderr: MainIo["stderr"]): ToolDeps {
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    redact: (text) => config.apiKey.redact(text),
    write: stderr,
  });
  const memory = config.cache === "memory";
  const client = new LegislationClient({
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    cache: memory ? new MemoryCache(CACHE_MAX_ENTRIES) : undefined,
    logger,
  });
  logger.info("starting", { server: SERVER_NAME, version: VERSION, cache: config.cache });
  return {
    client,
    logger,
    today: todayInNewZealand,
    textCache: memory ? new MemoryCache(TEXT_CACHE_MAX_ENTRIES) : undefined,
    xml: streamVersionXml,
  };
}

const USAGE = `Usage: ${SERVER_NAME} [stdio|http|setup|doctor] [--version] [--help]

  stdio    Serve MCP over standard input/output (default; for desktop and CLI clients).
  http     Serve MCP over HTTP (Streamable HTTP). Binds 127.0.0.1 unless OAuth is configured.
  setup    Save your API key in a private file and show how to add the server to your client.
  doctor   Check the key, the Legislation API and the website are reachable.

Configuration is by environment variables; see README.md and docs/self-hosting.md.
`;

/** `setup`, wired to the real terminal and API (modules loaded only when used). */
async function runSetupCommand(argv: readonly string[], io: MainIo): Promise<number> {
  const [{ runSetup, verifyWithApi }, terminal] = await Promise.all([
    import("./cli/setup.js"),
    import("./cli/terminal.js"),
  ]);
  return runSetup(argv, {
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    readSecret: (prompt) => terminal.readSecret(prompt, io.stdin, io.stderr),
    readStdin: () => terminal.readAll(io.stdin),
    verify: verifyWithApi,
  });
}

/** `doctor`, wired to the real environment. */
async function runDoctorCommand(io: MainIo): Promise<number> {
  const { runDoctor } = await import("./cli/doctor.js");
  return runDoctor({
    env: io.env,
    stdout: io.stdout,
    nodeVersion: process.version,
    fetch: globalThis.fetch,
  });
}

/**
 * Runs the command line. Returns the process exit code, or undefined while a server runs.
 * `http` is loaded lazily so stdio mode never loads the HTTP stack.
 */
export async function runCli(
  argv: readonly string[],
  io: MainIo = defaultIo,
  http: () => Promise<number | undefined> = async () =>
    (await import("./http/serve.js")).serveHttp({
      ...io,
      listen: (await import("./http/node.js")).listen,
      fetch: globalThis.fetch,
    }),
): Promise<number | undefined> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (command === "setup") return runSetupCommand(rest, io);
  if (command === "doctor" && rest.length === 0) return runDoctorCommand(io);
  if (rest.length > 0 || (command !== undefined && command !== "stdio" && command !== "http")) {
    io.stderr(USAGE);
    return 2;
  }
  return command === "http" ? http() : main(io);
}

/**
 * Starts the stdio server. Returns the process exit code for start-up failures, else undefined.
 *
 * @internal Exported for tests (use runCli).
 */
export function main(io: MainIo = defaultIo): number | undefined {
  let deps: ToolDeps;
  try {
    deps = buildDeps(io.env, io.stderr);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${SERVER_NAME}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const handle = io.serve(() => createServer(deps), {
    // e.g. malformed JSON from the client: log it (redacted) instead of dropping it silently.
    onerror: (error) => {
      deps.logger.warn("stdio transport error", { error });
    },
  });
  io.onUnhandledRejection((reason) => {
    deps.logger.error("unhandled promise rejection", { reason });
  });
  const stop = (): void => {
    deps.logger.info("shutting down");
    handle.close().catch((error: unknown) => {
      deps.logger.error("error while shutting down", { error });
    });
  };
  io.onSignal("SIGINT", stop);
  io.onSignal("SIGTERM", stop);
  return undefined;
}
