/**
 * Package version, read once from package.json (the single source of truth).
 *
 * This file sits at the root of `src/` and compiles to the root of `dist/`, so the relative path
 * to package.json is the same in development and in the published package.
 */
import { readFileSync } from "node:fs";

/**
 * Extracts the version from package.json text; falls back to 0.0.0 if absent.
 *
 * @internal Exported for tests.
 */
export function versionFromPackageJson(raw: string): string {
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

export const VERSION = versionFromPackageJson(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/** Machine name of this server, used in MCP `serverInfo`, the npm package and logs. */
export const SERVER_NAME = "nz-legislation-mcp";

/** Human-readable name shown by MCP clients. */
export const SERVER_TITLE = "NZ Legislation";

/** User-Agent sent to the API so PCO can identify (and contact the maintainers about) this client. */
export const USER_AGENT = `nz-legislation-mcp/${VERSION} (+https://github.com/thatskiff33/nz-legislation-mcp)`;
