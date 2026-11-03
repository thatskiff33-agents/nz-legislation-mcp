/**
 * Package entry point. The MCP server is wired up here in later issues (#6).
 */

/** Machine name of this server, used in MCP `serverInfo` and logs. */
export const SERVER_NAME = "nz-legislation-mcp";

/** Human-readable name shown by MCP clients. */
export const SERVER_TITLE = "NZ Legislation";

/**
 * Formats the identifying banner written to stderr at start-up.
 * Never include configuration values here: it must stay safe to log.
 */
export function startupBanner(version: string): string {
  return `${SERVER_TITLE} MCP server (${SERVER_NAME}) v${version}`;
}
