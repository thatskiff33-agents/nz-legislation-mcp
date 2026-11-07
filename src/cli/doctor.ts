/**
 * `nz-legislation-mcp doctor`: checks that everything needed to run the server is in place.
 * Makes one API request (counts against the daily quota) and one request to the website.
 *
 * Exit code: 1 if a required check failed (Node.js version, configuration and key, the
 * Legislation API), otherwise 0. Warnings (the website, which only the text tools need) do not
 * change the exit code, but the summary says they happened.
 */
import { LegislationClient } from "../api/client.js";
import type { ApiError } from "../api/errors.js";
import { existsSync } from "node:fs";
import { defaultKeyFilePath, loadConfig, type ConfigError } from "../config.js";
import { WEBSITE_ORIGIN } from "../domain/vocabulary.js";
import { MIN_NODE_MAJOR, USER_AGENT, VERSION } from "../version.js";
import { terminalMessage } from "./messages.js";

export interface DoctorIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly nodeVersion: string;
  readonly fetch: typeof fetch;
}

type Status = "ok" | "warn" | "fail";

export async function runDoctor(io: DoctorIo): Promise<number> {
  const results: Status[] = [];
  const report = (status: Status, check: string, detail: string): void => {
    results.push(status);
    io.stdout(`[${status}] ${check}: ${detail}\n`);
  };

  io.stdout(`nz-legislation-mcp ${VERSION}\n`);
  const major = Number(/^v?(\d+)/u.exec(io.nodeVersion)?.[1] ?? 0);
  if (major >= MIN_NODE_MAJOR) report("ok", "Node.js", io.nodeVersion);
  else
    report(
      "fail",
      "Node.js",
      `${io.nodeVersion} (version ${String(MIN_NODE_MAJOR)} or later is required)`,
    );

  let config;
  try {
    config = loadConfig(io.env);
    report("ok", "API key", `found and well-formed, from ${config.keySource}`);
    // A stale environment setting silently overrides the key saved by setup; say so.
    const saved = defaultKeyFilePath(io.env);
    if (!config.keySource.includes(saved) && existsSync(saved)) {
      report("warn", "Saved key", `the key saved by setup at ${saved} is not being used`);
    }
  } catch (error) {
    // loadConfig only throws ConfigError.
    report("fail", "Configuration", (error as ConfigError).problems.join(" "));
  }

  if (config !== undefined) {
    const client = new LegislationClient({
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      fetch: io.fetch,
      maxRetries: 0,
    });
    try {
      await client.searchWorks({
        search_term: "Interpretation",
        search_field: "title",
        per_page: 1,
      });
      const quota = client.quota;
      report(
        "ok",
        "Legislation API",
        quota === undefined
          ? "reachable"
          : `reachable; ${String(quota.remaining)} of ${String(quota.limit)} requests left today`,
      );
    } catch (error) {
      // The client only rejects with ApiError here (inputs are fixed and valid).
      report("fail", "Legislation API", terminalMessage(error as ApiError, "doctor"));
    }
  }

  try {
    const response = await io.fetch(`${WEBSITE_ORIGIN}/robots.txt`, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) report("ok", "legislation.govt.nz (for text)", "reachable");
    else report("warn", "legislation.govt.nz (for text)", `HTTP ${String(response.status)}`);
  } catch {
    report("warn", "legislation.govt.nz (for text)", "not reachable (text tools will fail)");
  }

  const failed = results.includes("fail");
  const warned = results.includes("warn");
  io.stdout(
    failed
      ? "\nSome required checks failed.\n"
      : warned
        ? "\nAll required checks passed, with warnings.\n"
        : "\nAll checks passed.\n",
  );
  return failed ? 1 : 0;
}
