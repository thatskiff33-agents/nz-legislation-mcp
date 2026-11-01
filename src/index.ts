/**
 * Public package entry. Most users run the `nz-legislation-mcp` command (src/cli.ts); this
 * module lets other programs embed the server.
 */
export { createServer, SERVER_INSTRUCTIONS, TOOLS } from "./server.js";
export { SERVER_NAME, SERVER_TITLE, VERSION } from "./version.js";
