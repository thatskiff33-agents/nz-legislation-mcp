/**
 * Streams the official XML for one version from www.legislation.govt.nz.
 *
 * Security: the URL is built from a validated version_id (never from an API-supplied link), the
 * host must be exactly WEBSITE_ORIGIN, no API key or credentials are sent, redirects are not
 * followed, and the body is size-capped while streaming.
 */
import { apiErrors, xmlErrors, type ApiError } from "../api/errors.js";
import { parseVersionId, websiteUrl } from "../domain/ids.js";
import { WEBSITE_ORIGIN } from "../domain/vocabulary.js";
import { ToolInputError } from "../tools/shared.js";
import { USER_AGENT } from "../version.js";

export interface XmlSourceOptions {
  readonly fetch?: typeof fetch;
  /** Whole-download timeout. Large Acts are tens of MB, so this is longer than API calls. */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** The largest consolidated Acts are a few tens of MB of XML. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The dated XML URL for a version, or a ToolInputError explaining why there is none.
 *
 * @internal Exported for tests.
 */
export function xmlUrlFor(versionId: string): URL {
  const parsed = parseVersionId(versionId);
  if (!parsed.ok) throw new ToolInputError(parsed.error);
  const href = websiteUrl(parsed.value, "xml");
  if (href === undefined) {
    throw new ToolInputError(
      "Text is not available for agency-published records (their documents are hosted on agency websites). Use the links from get_legislation instead.",
    );
  }
  return assertWebsiteUrl(new URL(href));
}

/**
 * Defence in depth: only ever fetch from the official website host.
 *
 * @internal Exported for tests.
 */
export function assertWebsiteUrl(url: URL): URL {
  if (url.origin !== WEBSITE_ORIGIN) throw new TypeError("Refusing to fetch XML off-site.");
  return url;
}

/**
 * Yields decoded text chunks of the version's XML. Stop iterating early (e.g. `break`) to
 * cancel the download; the underlying stream is released either way.
 */
export async function* streamVersionXml(
  versionId: string,
  signal: AbortSignal,
  options: XmlSourceOptions = {},
): AsyncGenerator<string> {
  const url = xmlUrlFor(versionId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = options.fetch ?? globalThis.fetch;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/xml", "User-Agent": USER_AGENT },
      redirect: "manual",
      credentials: "omit",
      signal: combined,
    });
  } catch (error) {
    throw transportError(error, timeoutMs, signal);
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    if (status === 404) throw xmlErrors.notFound(versionId);
    if (status >= 300 && status < 400) throw xmlErrors.unexpectedRedirect(status);
    if (status === 502 || status === 503 || status === 504) {
      throw xmlErrors.unavailable(status);
    }
    throw xmlErrors.unexpectedStatus(status);
  }
  if (response.body === null) throw xmlErrors.unreadable();

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw transportError(error, timeoutMs, signal);
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw xmlErrors.tooLarge(maxBytes);
      yield decoder.decode(chunk.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } finally {
    // Releases the connection when the consumer stops early or an error occurs.
    await reader.cancel().catch(() => undefined);
  }
}

function transportError(error: unknown, timeoutMs: number, caller: AbortSignal): ApiError {
  if (caller.aborted) return apiErrors.cancelled();
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return xmlErrors.timeout(timeoutMs);
  }
  return xmlErrors.network();
}
