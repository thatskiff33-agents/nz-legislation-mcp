/**
 * MCP resource templates, for clients that let users attach legislation as context (for example
 * Claude Desktop and VS Code). Each read runs the matching tool, so resources and tools share one
 * text pipeline, one set of input rules and one set of error messages.
 *
 *   legislation://version/{version_id}/contents           table of contents
 *   legislation://version/{version_id}/section/{section}  one section
 *   legislation://version/{version_id}/schedule/{schedule} one schedule
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type Variables,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import { ApiError } from "./api/errors.js";
import { getProvisionText } from "./tools/get-provision-text.js";
import { getTableOfContents } from "./tools/get-table-of-contents.js";
import { ToolInputError, type ToolDefinition, type ToolDeps } from "./tools/shared.js";
import { TEXT_SOURCE_NOTE } from "./tools/text-common.js";

/** Longest text a resource returns; longer provisions point to the paged tool. */
const MAX_RESOURCE_CHARS = 50_000;

const MIME = "text/markdown";

/**
 * One URI-template variable, percent-decoded. (The SDK passes variables still
 * encoded, so "CA%201" becomes "CA 1". Labels and IDs never contain "%", so decoding once is
 * unambiguous; a malformed encoding is rejected.)
 */
function single(variables: Variables, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(String(variables[name]));
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid resource URI: bad encoding in ${name}.`,
    );
  }
  // One spelling per resource: no leading/trailing spaces (they would be trimmed to the same
  // label, so "schedule/%201" and "schedule/1" would name the same text).
  if (value !== value.trim()) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid resource URI: ${name} must not start or end with a space.`,
    );
  }
  return value;
}

/**
 * Validates arguments with the tool's own input schema and runs it, mapping failures to protocol
 * errors whose messages are safe to show (no key, no internals).
 */
async function runTool<I extends z.ZodType, O extends z.ZodType>(
  tool: ToolDefinition<I, O>,
  uri: URL,
  args: Record<string, unknown>,
  deps: ToolDeps,
  signal: AbortSignal,
): Promise<z.output<O>> {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid resource URI: ${detail}`);
  }
  try {
    return await tool.run(parsed.data, deps, signal);
  } catch (error) {
    if (error instanceof ToolInputError) throw new ResourceNotFoundError(uri.href, error.message);
    if (error instanceof ApiError && error.kind === "not_found") {
      throw new ResourceNotFoundError(uri.href, error.message);
    }
    if (error instanceof ApiError)
      throw new ProtocolError(ProtocolErrorCode.InternalError, error.message);
    deps.logger.error("unexpected resource failure", { tool: tool.name, error });
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "An unexpected error occurred in this MCP server.",
    );
  }
}

/** Tool notes that mention tool-only parameters, reworded for a resource reader. */
function forResource(note: string): string {
  return note.replace(
    "Pass part to choose another.",
    "To read another, use the get_provision_text tool with part (resource URIs cannot choose).",
  );
}

/** "Version <id> (<permalink>)." Agency-published records have no permalink. */
function versionLine(versionId: string, link: string | null): string {
  return `Version ${versionId}${link === null ? "" : ` (${link})`}.`;
}

function markdown(uri: URL, lines: readonly string[]): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: MIME, text: `${lines.join("\n")}\n` }] };
}

async function readContents(
  uri: URL,
  variables: Variables,
  deps: ToolDeps,
  signal: AbortSignal,
): Promise<ReadResourceResult> {
  const out = await runTool(
    getTableOfContents,
    uri,
    { version_id: single(variables, "version_id") },
    deps,
    signal,
  );
  const entries = out.entries.map((e) => {
    const indent = "  ".repeat(Math.max(0, e.depth));
    const label = e.label === "" ? "" : `${e.label} `;
    return `${indent}- ${e.kind} ${label}${e.heading}${e.repealed ? " [Repealed]" : ""}`;
  });
  return markdown(uri, [
    `# ${out.title}: contents`,
    "",
    `${versionLine(out.version_id, out.permalink)} ${out.scope}`,
    "",
    ...entries,
    "",
    ...out.notes,
  ]);
}

async function readProvision(
  uri: URL,
  args: Record<string, unknown>,
  deps: ToolDeps,
  signal: AbortSignal,
): Promise<ReadResourceResult> {
  const out = await runTool(
    getProvisionText,
    uri,
    { ...args, max_chars: MAX_RESOURCE_CHARS },
    deps,
    signal,
  );
  const where = out.provision.kind === "schedule" ? "Schedule" : "Section";
  return markdown(uri, [
    `# ${out.title}, ${where.toLowerCase()} ${out.provision.label}: ${out.provision.heading}`,
    "",
    versionLine(out.version_id, out.permalink),
    "",
    out.text,
    ...(out.next_offset === null
      ? []
      : [
          "",
          `[Text continues: ${String(out.total_chars - out.next_offset)} more characters. Use the get_provision_text tool with version_id ${out.version_id} and offset ${String(out.next_offset)}.]`,
        ]),
    "",
    ...out.notes.filter((note) => note !== TEXT_SOURCE_NOTE).map(forResource),
    TEXT_SOURCE_NOTE,
  ]);
}

/** Registers the resource templates (no listing: there are far too many versions to list). */
export function registerResources(server: McpServer, deps: ToolDeps): void {
  const template = (pattern: string): ResourceTemplate =>
    new ResourceTemplate(pattern, { list: undefined });

  server.registerResource(
    "legislation-contents",
    template("legislation://version/{version_id}/contents"),
    {
      title: "Table of contents of a version",
      description:
        "Parts, sections and schedules of one version of NZ legislation. version_id comes from search_legislation or get_legislation.",
      mimeType: MIME,
    },
    (uri, variables, ctx) => readContents(uri, variables, deps, ctx.mcpReq.signal),
  );
  server.registerResource(
    "legislation-section",
    template("legislation://version/{version_id}/section/{section}"),
    {
      title: "Text of a section",
      description: 'One section of a version of NZ legislation, e.g. section "13" or "CA 1".',
      mimeType: MIME,
    },
    (uri, variables, ctx) =>
      readProvision(
        uri,
        { version_id: single(variables, "version_id"), section: single(variables, "section") },
        deps,
        ctx.mcpReq.signal,
      ),
  );
  server.registerResource(
    "legislation-schedule",
    template("legislation://version/{version_id}/schedule/{schedule}"),
    {
      title: "Text of a schedule",
      description: 'One whole schedule of a version of NZ legislation, e.g. schedule "1".',
      mimeType: MIME,
    },
    (uri, variables, ctx) =>
      readProvision(
        uri,
        { version_id: single(variables, "version_id"), schedule: single(variables, "schedule") },
        deps,
        ctx.mcpReq.signal,
      ),
  );
}
