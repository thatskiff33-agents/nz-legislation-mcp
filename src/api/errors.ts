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

/** Where users report problems with this server. */
const REPORT_URL = "https://github.com/thatskiff33/nz-legislation-mcp/issues";

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
      "The Legislation API rejected the API key (401). The user should check which key the server is using and that it is their own valid key: in a terminal, `npx nz-legislation-mcp doctor` shows which key that terminal finds (a key set in the AI client's settings is seen only by that client). It can come from LEGISLATION_NZ_API_KEY, a file named by LEGISLATION_NZ_API_KEY_FILE, the key file saved by `nz-legislation-mcp setup`, or the AI client's settings (Claude Code plugin, Claude Desktop bundle); on a self-hosted endpoint it is the operator's key, so ask the operator. Keys are issued by the Parliamentary Counsel Office (contact@pco.govt.nz). Do not retry.",
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
      `The Legislation API returned a response in an unexpected format. The API (v0) may have changed; please report this at ${REPORT_URL}.`,
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
      `The Legislation API answered with a redirect (${String(status)}), which this server does not follow for security. The API may have moved; please report this at ${REPORT_URL}.`,
      false,
      status,
    ),

  internal: (): ApiError =>
    new ApiError(
      "internal_error",
      `An internal error occurred in this MCP server while handling the API response. Please report it at ${REPORT_URL}.`,
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

/** Where the legislation text (XML) comes from: the public website, not the API. */
const WEBSITE = "the legislation website (www.legislation.govt.nz)";

/**
 * Errors for downloading and reading a version's text (XML) from the website. Same kinds as
 * apiErrors (so structured output is unchanged), with messages that name the right source and
 * give remedies that apply to a whole-document download.
 */
export const xmlErrors = {
  notFound: (versionId: string, page: string): ApiError =>
    new ApiError(
      "not_found",
      `The text (XML) of ${versionId} was not found on ${WEBSITE} (404). It may not be published yet: use list_versions to pick another version, or check the version's page: ${page}`,
      false,
      404,
    ),

  unexpectedRedirect: (status: number): ApiError =>
    new ApiError(
      "unexpected_redirect",
      `${capitalise(WEBSITE)} answered with a redirect (${String(status)}) for the text (XML), which this server does not follow for security. The website may have moved; please report this at ${REPORT_URL}.`,
      false,
      status,
    ),

  unavailable: (status: number): ApiError =>
    new ApiError(
      "upstream_unavailable",
      `${capitalise(WEBSITE)} is temporarily unavailable (${String(status)}). Try again in a minute.`,
      true,
      status,
    ),

  unexpectedStatus: (status: number): ApiError =>
    new ApiError(
      "upstream_error",
      `${capitalise(WEBSITE)} returned an unexpected status (${String(status)}) for the text (XML). This may be a problem with the website; do not retry the same request repeatedly.`,
      false,
      status,
    ),

  unreadable: (): ApiError =>
    new ApiError(
      "invalid_response",
      `${capitalise(WEBSITE)} returned text (XML) this server could not read. It may be a temporary problem; if it persists, please report it at ${REPORT_URL}.`,
      false,
    ),

  tooLarge: (limitBytes: number, page: string): ApiError =>
    new ApiError(
      "response_too_large",
      `The text (XML) of this version is larger than the ${sizeLimit(limitBytes)} safety limit, so it could not be read to the end. A single section or schedule (get_provision_text) may still work, because reading stops once it is found; otherwise read it on the official page: ${page}`,
      false,
    ),

  timeout: (ms: number): ApiError =>
    new ApiError(
      "timeout",
      `${capitalise(WEBSITE)} did not send the text (XML) within ${String(ms)} ms. Try again shortly; very large Acts take longer.`,
      true,
    ),

  network: (): ApiError =>
    new ApiError(
      "network",
      `Could not reach ${WEBSITE}. Check the internet connection and try again.`,
      true,
    ),
} as const;

/** A byte limit for people: whole MB when it is at least 1 MB, otherwise bytes. */
function sizeLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${String(Math.round(mb))} MB` : `${String(bytes)}-byte`;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
