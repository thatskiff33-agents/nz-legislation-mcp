/**
 * Minimal adapter from Node's http server to a fetch handler, with conservative timeouts.
 * (Avoids a web-framework dependency: the app is a plain Request -> Response function.)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

/** Starts listening; resolves once the server is accepting connections. */
export async function listen(
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions,
): Promise<Server> {
  const server = createServer((req, res) => {
    const request = toRequest(req, res);
    handler(request)
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
  server.maxHeadersCount = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
