/**
 * Building blocks shared by every tool: the tool definition shape, result/error conversion,
 * and output-schema fragments (dedicated output schemas, never the API response schemas, so
 * they convert cleanly to JSON Schema).
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LegislationClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { parseVersionId, websiteUrl } from "../domain/ids.js";
import type { Logger } from "../logger.js";

/** Dependencies every tool handler receives. */
export interface ToolDeps {
  readonly client: LegislationClient;
  readonly logger: Logger;
  /** Today's date in New Zealand (YYYY-MM-DD); injectable for tests. */
  readonly today: () => string;
}

/** Read-only, safe-to-repeat tools that call the external Legislation API. */
export const READ_ONLY_API_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  run(args: z.output<I>, deps: ToolDeps, signal: AbortSignal): Promise<z.output<O>>;
}

/** Helper that keeps each tool's input and output types tied to its schemas. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return tool;
}

/** Structured result plus the same JSON as text (spec: SHOULD, for older clients). */
export function toResult(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/** Converts a failure into a tool error the model can act on. Never leaks internals. */
export function toErrorResult(error: unknown, logger: Logger, tool: string): CallToolResult {
  if (error instanceof ApiError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  if (error instanceof ToolInputError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  logger.error("unexpected tool failure", { tool, error });
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "An unexpected error occurred in this MCP server. Please report it at https://github.com/thatskiff33-agents/nz-legislation-mcp/issues.",
      },
    ],
  };
}

/** A problem with the caller's request that schema validation cannot express. */
export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

// ---------------------------------------------------------------------------
// Output schema fragments
// ---------------------------------------------------------------------------

export const LinksSchema = z
  .object({
    html: z.string().optional(),
    pdf: z.string().optional(),
    xml: z.string().optional(),
    pdf_original_scan: z.string().optional(),
  })
  .describe(
    "Links to this version. legislation.govt.nz links are the official source; agency-published records may link to agency websites.",
  );
export type Links = z.output<typeof LinksSchema>;

const KNOWN_FORMATS = ["html", "pdf", "xml", "pdf_original_scan"] as const;

/** Picks the known format links; first link wins for duplicates. */
export function linksFrom(formats: readonly { type: string; url: string }[]): Links {
  const links: Record<string, string> = {};
  for (const { type, url } of formats) {
    if ((KNOWN_FORMATS as readonly string[]).includes(type) && links[type] === undefined) {
      links[type] = url;
    }
  }
  return links;
}

const nullableText = z.string().nullable();

/** Classification fields, flattened so each record has the same shape whatever its type. */
export const ClassificationShape = {
  legislation_type: nullableText.describe("act, bill, secondary_legislation or amendment_paper."),
  legislation_status: nullableText.describe("in_force, not_in_force or no_value."),
  type_status: nullableText.describe(
    "Status specific to the type: act_status, bill_status or instrument_status.",
  ),
  category: nullableText.describe("Sub-category: act_type, bill_type or instrument_type_group."),
  classification: nullableText.describe("principal or amendment, where recorded."),
  publisher: nullableText,
  administering_agencies: z.array(z.string()),
  agency_pilot_record: z
    .boolean()
    .describe(
      "True for agency-published records from PCO's pilot service, which may be inaccurate or incomplete.",
    ),
};

interface RawClassification {
  readonly legislation_type?: string | null | undefined;
  readonly legislation_status?: string | null | undefined;
  readonly act_type?: string | null | undefined;
  readonly act_status?: string | null | undefined;
  readonly act_classification?: string | null | undefined;
  readonly bill_type?: string | null | undefined;
  readonly bill_status?: string | null | undefined;
  readonly instrument_type_group?: string | null | undefined;
  readonly instrument_status?: string | null | undefined;
  readonly instrument_classification?: string | null | undefined;
  readonly publisher?: string | null | undefined;
  readonly administering_agencies?: readonly string[] | null | undefined;
}

export function classificationFrom(raw: RawClassification): {
  legislation_type: string | null;
  legislation_status: string | null;
  type_status: string | null;
  category: string | null;
  classification: string | null;
  publisher: string | null;
  administering_agencies: string[];
  agency_pilot_record: boolean;
} {
  return {
    legislation_type: raw.legislation_type ?? null,
    legislation_status: raw.legislation_status ?? null,
    type_status: raw.act_status ?? raw.bill_status ?? raw.instrument_status ?? null,
    category: raw.act_type ?? raw.bill_type ?? raw.instrument_type_group ?? null,
    classification: raw.act_classification ?? raw.instrument_classification ?? null,
    publisher: raw.publisher ?? null,
    administering_agencies: [...(raw.administering_agencies ?? [])],
    agency_pilot_record: raw.publisher === "Agency",
  };
}

/** The calendar date encoded in a version_id, or null if it cannot be parsed. */
export function versionDate(versionId: string): string | null {
  const parsed = parseVersionId(versionId);
  return parsed.ok ? parsed.value.date : null;
}

export const PermalinkSchema = z
  .string()
  .nullable()
  .describe(
    "Stable, dated legislation.govt.nz link to exactly this version (use it in citations). Null for agency-published records.",
  );

/** Dated website link for a version (unlike the API's /latest/ link, it never changes). */
export function permalink(versionId: string): string | null {
  const parsed = parseVersionId(versionId);
  return parsed.ok ? (websiteUrl(parsed.value, "html") ?? null) : null;
}

/** True when a version_id has provisional (~) parts that may change. */
export function isProvisional(versionId: string): boolean {
  const parsed = parseVersionId(versionId);
  return parsed.ok ? parsed.value.provisional : false;
}

/** Today's date in New Zealand as YYYY-MM-DD. */
export function todayInNewZealand(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Standard reminder included with every legislation result. */
export const OFFICIAL_SOURCE_NOTE =
  "Unofficial tool. Check the official version on legislation.govt.nz before relying on it; this is not legal advice.";

export const AGENCY_PILOT_NOTE =
  "Some results are agency-published records from PCO's pilot service and may be inaccurate or incomplete.";
