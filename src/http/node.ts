/**
 * Minimal adapter from Node's http server to a fetch handler, with conservative timeouts.
 * (Avoids a web-framework dependency: the app is a plain Request -> Response function.)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { Logger } from "../logger.js";

export interface NodeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
}

/** Converts a Node request into a web Request (body streamed, aborted if the client goes). */
export function toRequest(req: IncomingMessage, res: ServerResponse): Request {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const headers = new Headers();
  // headersDistinct always holds arrays for received headers.
  for (const [name, values] of Object.entries(req.headersDistinct) as [string, string[]][]) {
    for (const value of values) headers.append(name, value);
  }
  // The URL's host is only used for routing; the Host header is validated by the app.
  const url = new URL(String(req.url), "http://localhost");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: String(req.method),
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
  });
}

/** For cancellations whose failure does not matter (the stream is already gone). */
const ignore = (): void => undefined;

/** Writes a web Response to a Node response, streaming the body. */
export async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  // If the client goes while the body producer is itself waiting, cancel the read too.
  const cancelOnClose = (): void => {
    reader.cancel().catch(ignore);
  };
  res.once("close", cancelOnClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect backpressure: wait for the socket to drain before writing more. If the client
      // goes away instead, stop: "drain" would never come and the response would hang for good.
      if (!res.write(value) && !(await drainedOrClosed(res))) return;
    }
    res.end();
  } finally {
    // Releases the body (and the per-request server behind it) if we stopped early.
    await reader.cancel().catch(ignore);
    res.off("close", cancelOnClose);
  }
}

/**
 * Waits for "drain"; resolves false if the response closes (client gone) first.
 *
 * @internal Exported for tests.
 */
export async function drainedOrClosed(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return false;
  const controller = new AbortController();
  try {
    return await Promise.race([
      // The loser is aborted below; its rejection is expected and ignored.
      once(res, "drain", { signal: controller.signal }).then(
        () => true,
        () => false,
      ),
      once(res, "close", { signal: controller.signal }).then(
        () => false,
        () => false,
      ),
    ]);
  } finally {
    controller.abort();
  }
}

/**
 * Most request headers accepted. Node silently drops headers past its limit, so a request that
 * reaches the limit is refused: otherwise a client could pad its request until a proxy's
 * forwarding headers (which the no-auth mode refuses) fall off the end unseen.
 */
const MAX_HEADERS = 100;

/** Methods the MCP endpoint and health/metadata routes can use; anything else gets 405. */
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "DELETE", "OPTIONS"]);

/** Request details the adapter passes to the app alongside the Request. */
export interface RequestMeta {
  /** The client's IP address (for pre-authentication rate limiting). */
  readonly remoteAddress: string;
}

/** Starts listening; resolves once the server is accepting connections. */
export async function listen(
  handler: (request: Request, meta: RequestMeta) => Promise<Response>,
  options: NodeServerOptions,
): Promise<Server> {
  const server = createServer((req, res) => {
    // Everything here runs outside the promise chain, so it must never throw: an exception
    // would crash the process (one bad request line = denial of service).
    if (!ALLOWED_METHODS.has(String(req.method))) {
      res.writeHead(405, {
        Allow: [...ALLOWED_METHODS].join(", "),
        "Content-Type": "application/json",
      });
      res.end('{"error":"method_not_allowed"}');
      return;
    }
    // rawHeaders alternates names and values. Some Node releases cut it at exactly the limit with no
    // other signal (seen on 24.15.0); newer ones refuse such requests themselves (seen in CI on
    // 22.23.4 and 24.22.2). A request at the limit is refused here either way: keep ">=".
    if (req.rawHeaders.length / 2 >= MAX_HEADERS) {
      res.writeHead(431, { "Content-Type": "application/json", Connection: "close" });
      res.end('{"error":"too_many_headers"}');
      return;
    }
    let request: Request;
    try {
      request = toRequest(req, res);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"bad_request"}');
      return;
    }
    handler(request, { remoteAddress: String(req.socket.remoteAddress) })
      .then((response) => writeResponse(response, res))
      .catch((error: unknown) => {
        options.logger.error("http response failed", { error });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = MAX_HEADERS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
