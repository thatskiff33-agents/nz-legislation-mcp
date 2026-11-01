/**
 * Builds the MCP server: identity, instructions and the tool registry (deterministic order).
 */
import {
  McpServer,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import { getApiQuota } from "./tools/get-api-quota.js";
import { getLegislation } from "./tools/get-legislation.js";
import { listVersions } from "./tools/list-versions.js";
import { searchLegislation } from "./tools/search-legislation.js";
import { toErrorResult, toResult, type ToolDefinition, type ToolDeps } from "./tools/shared.js";
import { SERVER_NAME, SERVER_TITLE, VERSION } from "./version.js";

/** Every tool, in the order clients see them (spec: deterministic tools/list order). */
export const TOOLS = [searchLegislation, getLegislation, listVersions, getApiQuota] as const;

export const SERVER_INSTRUCTIONS = [
  "Tools for New Zealand legislation from the official legislation.govt.nz API (Parliamentary Counsel Office).",
  "Typical flow: search_legislation to find a work_id, then get_legislation (with as_at for a past date) for the version and official links; list_versions for the amendment history.",
  "Always cite the title, version date and legislation.govt.nz link. Results are not legal advice; tell the user to check the official version.",
  "Each user's API key has a daily quota (get_api_quota), so prefer specific searches over many broad ones.",
].join("\n");

/** Registers one tool, keeping its input/output types tied to its schemas. */
function register<
  I extends z.ZodType & StandardSchemaWithJSON,
  O extends z.ZodType & StandardSchemaWithJSON,
>(server: McpServer, tool: ToolDefinition<I, O>, deps: ToolDeps): void {
  // The SDK types the callback as a conditional type that TypeScript cannot resolve for a
  // generic I, so the handler is written against the SDK's own callback type explicitly.
  const handler = (async (args: z.output<I>, ctx: ServerContext) => {
    try {
      // The SDK has already validated args against inputSchema.
      const output = await tool.run(args, deps, ctx.mcpReq.signal);
      return toResult(output as Record<string, unknown>);
    } catch (error) {
      return toErrorResult(error, deps.logger, tool.name);
    }
  }) as ToolCallback<I>;

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    },
    handler,
  );
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  register(server, searchLegislation, deps);
  register(server, getLegislation, deps);
  register(server, listVersions, deps);
  register(server, getApiQuota, deps);
  return server;
}
