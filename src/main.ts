/**
 * Process entry logic for the stdio server: load config, wire dependencies, serve, and shut
 * down cleanly. Kept separate from cli.ts so it can be tested without spawning a process.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MemoryCache } from "./api/cache.js";
import { LegislationClient } from "./api/client.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { todayInNewZealand, type ToolDeps } from "./tools/shared.js";
import { SERVER_NAME, VERSION } from "./version.js";

/** Bounded size of the optional response cache. */
const CACHE_MAX_ENTRIES = 500;

export interface MainIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: (text: string) => void;
  readonly serve: typeof serveStdio;
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

/** @internal Exported for tests. */
export const defaultIo: MainIo = {
  env: process.env,
  stderr: (text) => process.stderr.write(text),
  serve: serveStdio,
  onSignal: (signal, handler) => process.once(signal, handler),
};

/** Builds the dependencies shared by every tool call. */
function buildDeps(env: MainIo["env"], stderr: MainIo["stderr"]): ToolDeps {
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    redact: (text) => config.apiKey.redact(text),
    write: stderr,
  });
  const client = new LegislationClient({
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    cache: config.cache === "memory" ? new MemoryCache(CACHE_MAX_ENTRIES) : undefined,
    logger,
  });
  logger.info("starting", { server: SERVER_NAME, version: VERSION, cache: config.cache });
  return { client, logger, today: todayInNewZealand };
}

/** Starts the stdio server. Returns the process exit code for start-up failures, else undefined. */
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
  const handle = io.serve(() => createServer(deps));
  const stop = (): void => {
    deps.logger.info("shutting down");
    void handle.close();
  };
  io.onSignal("SIGINT", stop);
  io.onSignal("SIGTERM", stop);
  return undefined;
}
