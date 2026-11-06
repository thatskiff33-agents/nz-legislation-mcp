/**
 * Package facts, read once from package.json (the single source of truth): the version, the
 * repository URL and the minimum Node.js version.
 *
 * This file sits at the root of `src/` and compiles to the root of `dist/`, so the relative path
 * to package.json is the same in development and in the published package.
 */
import { readFileSync } from "node:fs";

/** @internal The facts packageInfo reads (exported with it for tests). */
export interface PackageInfo {
  readonly version: string;
  /** e.g. https://github.com/thatskiff33/nz-legislation-mcp */
  readonly repositoryUrl: string;
  /** e.g. thatskiff33/nz-legislation-mcp */
  readonly repositorySlug: string;
  /** The major version in engines.node (">=22" gives 22). */
  readonly minNodeMajor: number;
}

/**
 * Reads the package facts from package.json text. The version falls back to 0.0.0; a missing or
 * unexpected repository URL or engines.node is a packaging error and throws.
 *
 * @internal Exported for tests.
 */
export function packageInfo(raw: string): PackageInfo {
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    repository?: { url?: unknown };
    engines?: { node?: unknown };
  };
  const url = typeof parsed.repository?.url === "string" ? parsed.repository.url : "";
  const repositoryUrl = url.replace(/^git\+/u, "").replace(/\.git$/u, "");
  const slug = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/u.exec(repositoryUrl)?.[1];
  if (slug === undefined) {
    throw new Error("package.json repository.url must be a https://github.com/<owner>/<repo> URL.");
  }
  const node = typeof parsed.engines?.node === "string" ? parsed.engines.node : "";
  const major = /^>=\s*(\d+)/u.exec(node)?.[1];
  if (major === undefined) throw new Error('package.json engines.node must read ">=N".');
  return {
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    repositoryUrl,
    repositorySlug: slug,
    minNodeMajor: Number(major),
  };
}

const PACKAGE = packageInfo(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = PACKAGE.version;
export const REPOSITORY_URL = PACKAGE.repositoryUrl;
export const REPOSITORY_SLUG = PACKAGE.repositorySlug;
export const MIN_NODE_MAJOR = PACKAGE.minNodeMajor;

/** Machine name of this server, used in MCP `serverInfo`, the npm package and logs. */
export const SERVER_NAME = "nz-legislation-mcp";

/** Human-readable name shown by MCP clients. */
export const SERVER_TITLE = "NZ Legislation";

/** User-Agent sent to the API so PCO can identify (and contact the maintainers about) this client. */
export const USER_AGENT = `nz-legislation-mcp/${VERSION} (+${REPOSITORY_URL})`;
