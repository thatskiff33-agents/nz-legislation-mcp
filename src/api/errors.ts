/**
 * Typed errors for Legislation API calls.
 *
 * Each error has a stable `kind` (for code and structured tool output) and a message written
 * for the AI model calling the tool: what happened and what to do next. Messages never contain
 * the API key or raw upstream bodies.
 */

export type ApiErrorKind =
  | "unauthorised"
  | "not_found"
  | "daily_quota_exceeded"
  | "burst_limit_exceeded"
  | "upstream_unavailable"
  | "upstream_error"
  | "timeout"
  | "network"
  | "invalid_response"
  | "response_too_large"
  | "unexpected_redirect"
  | "circuit_open"
  | "cancelled"
  | "internal_error";

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    /** Whether retrying the same call later could succeed. */
    readonly retryable: boolean,
    /** Upstream HTTP status, when there was one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Formats a Unix-seconds reset time as an ISO timestamp, if present and sane. */
function resetHint(resetEpochSeconds: number | undefined): string {
  if (resetEpochSeconds === undefined) return "at midnight New Zealand time";
  return `at ${new Date(resetEpochSeconds * 1000).toISOString()}`;
}

export const apiErrors = {
  unauthorised: (): ApiError =>
    new ApiError(
      "unauthorised",
      "The Legislation API rejected the API key (401). The user must check that LEGISLATION_NZ_API_KEY is set to their own valid key. Keys are issued by the Parliamentary Counsel Office (contact@pco.govt.nz). Do not retry.",
      false,
      401,
    ),

  notFound: (what: string): ApiError =>
    new ApiError(
      "not_found",
      `${what} was not found (404). Check the identifier, or use search_legislation / list_versions to find a valid one.`,
      false,
      404,
    ),

  dailyQuota: (resetEpochSeconds?: number): ApiError =>
    new ApiError(
      "daily_quota_exceeded",
      `The daily API quota for this key is used up (429). It resets ${resetHint(resetEpochSeconds)}. Do not retry before then.`,
      false,
      429,
    ),

  burstLimit: (): ApiError =>
    new ApiError(
      "burst_limit_exceeded",
      "Too many requests from this network in five minutes (403, limit 2,000 per IP). Wait five minutes before trying again, and make fewer, broader requests.",
      true,
      403,
    ),

  upstreamUnavailable: (status: number): ApiError =>
    new ApiError(
      "upstream_unavailable",
      `The Legislation API is temporarily unavailable (${String(status)}). Try again in a minute.`,
      true,
      status,
    ),

  upstreamError: (status: number): ApiError =>
    new ApiError(
      "upstream_error",
      `The Legislation API returned an unexpected status (${String(status)}). This may be a problem with the API; do not retry the same request repeatedly.`,
      false,
      status,
    ),

  timeout: (ms: number): ApiError =>
    new ApiError(
      "timeout",
      `The Legislation API did not respond within ${String(ms)} ms. Try again shortly, or narrow the request.`,
      true,
    ),

  network: (): ApiError =>
    new ApiError(
      "network",
      "Could not reach the Legislation API (network error). Check the internet connection and try again.",
      true,
    ),

  invalidResponse: (): ApiError =>
    new ApiError(
      "invalid_response",
      "The Legislation API returned a response in an unexpected format. The API (v0) may have changed; please report this at https://github.com/thatskiff33-agents/nz-legislation-mcp/issues.",
      false,
    ),

  tooLarge: (limitBytes: number): ApiError =>
    new ApiError(
      "response_too_large",
      `The API response exceeded the ${String(limitBytes)}-byte safety limit. Request fewer results per page.`,
      false,
    ),

  unexpectedRedirect: (status: number): ApiError =>
    new ApiError(
      "unexpected_redirect",
      `The Legislation API answered with a redirect (${String(status)}), which this server does not follow for security. The API may have moved; please report this at https://github.com/thatskiff33-agents/nz-legislation-mcp/issues.`,
      false,
      status,
    ),

  internal: (): ApiError =>
    new ApiError(
      "internal_error",
      "An internal error occurred in this MCP server while handling the API response. Please report it at https://github.com/thatskiff33-agents/nz-legislation-mcp/issues.",
      false,
    ),

  cancelled: (): ApiError =>
    new ApiError("cancelled", "The request was cancelled before it completed.", false),

  circuitOpen: (retryAfterMs: number): ApiError =>
    new ApiError(
      "circuit_open",
      `Requests to the Legislation API are paused for ${String(Math.ceil(retryAfterMs / 1000))} s after repeated failures. Try again after that.`,
      true,
    ),
} as const;
