/**
 * The HTTP application as a web-standard fetch handler (Request -> Response).
 *
 * Request pipeline:
 *   security headers (all responses)
 *   -> Host header check (DNS-rebinding defence)
 *   -> Origin check (browser requests only from allowed origins)
 *   -> routes: GET /healthz, RFC 9728 protected-resource metadata, /mcp
 *   -> /mcp: bearer token (OAuth) -> per-subject rate limit -> SDK stateless MCP handler.
 *
 * The MCP endpoint is stateless (protocol 2026-07-28, with legacy fallback handled by the SDK),
 * so no session state is kept between requests.
 */
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { createServer } from "../server.js";
import type { ToolDeps } from "../tools/shared.js";
import { MCP_PATH, type HttpConfig } from "./config.js";
import { RateLimiter } from "./rate-limit.js";

export interface HttpAppOptions {
  readonly config: HttpConfig;
  readonly deps: ToolDeps;
  readonly logger: Logger;
  /** Required when config.oauth is set. */
  readonly auth?: {
    readonly verifier: OAuthTokenVerifier;
    readonly authorizationServer: OAuthMetadata;
  };
  readonly now?: () => number;
}

export interface HttpApp {
  readonly fetch: (
    request: Request,
    meta?: { readonly remoteAddress: string },
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function withSecurityHeaders(response: Response, https: boolean): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (https) headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** The pre-authentication per-IP limit is this multiple of the per-user limit. */
const PRE_AUTH_MULTIPLIER = 5;
/** Largest accepted request body (matches the SDK's own default). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const rateLimited = (): Response =>
  json(
    429,
    { error: "rate_limited", message: "Too many requests. Wait a minute and try again." },
    { "Retry-After": "60" },
  );

/** The verified token subject ("local" without OAuth, "" if a verifier supplied none). */
function subjectOf(authInfo: AuthInfo | undefined): string {
  if (authInfo === undefined) return "local";
  const subject = authInfo.extra?.["subject"];
  return typeof subject === "string" ? subject : "";
}

/**
 * The client address for per-IP limits. Behind a trusted proxy (which appends the address it
 * saw to X-Forwarded-For), that last entry is used; earlier entries can be set by the client
 * and are ignored. Without a trusted proxy, the socket address is used.
 */
function clientAddress(request: Request, socketAddress: string, trustProxy: boolean): string {
  if (!trustProxy) return socketAddress;
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? socketAddress : withoutPort(last);
}

/**
 * Headers a reverse proxy, tunnel or CDN adds; a no-auth server must never be behind one. A plain
 * TCP forwarder, or a proxy configured to add none of these, is not detected (see the threat
 * model): the real protection is OAuth.
 */
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "via",
  "x-forwarded-server",
  "x-forwarded-port",
  "x-original-forwarded-for",
  "x-client-ip",
  "fastly-client-ip",
  "x-envoy-external-address",
  "cdn-loop",
  "cf-ray",
];

/** True for IPv4 127.0.0.0/8, IPv6 ::1 and IPv4-mapped loopback addresses. */
function isLoopbackAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(v4);
}

/**
 * Without OAuth, only direct connections from this machine are served. A proxy or tunnel that
 * rewrites Host to a loopback name would otherwise pass the Host check and expose the key holder's
 * quota to anyone, so proxy headers and non-loopback peers are refused.
 */
function unauthenticatedRejection(request: Request, socketAddress: string): Response | undefined {
  if (!isLoopbackAddress(socketAddress) || PROXY_HEADERS.some((h) => request.headers.has(h))) {
    return json(403, {
      error: "forbidden",
      message:
        "This server has no authentication, so it only accepts direct connections from this computer. To serve it through a proxy or tunnel, configure OAuth (see docs/self-hosting.md).",
    });
  }
  return undefined;
}

/**
 * The key for per-IP limits: IPv4 as is, IPv6 by its /64 prefix (one host usually controls a
 * whole /64, so per-address buckets would be trivial to spread across).
 */
function ipKey(address: string): string {
  if (!address.includes(":") || address.startsWith("::ffff:")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::")
    ? [
        ...left,
        ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => "0"),
        ...right,
      ]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/u, ""))
    .join(":")}::/64`;
}

/** "1.2.3.4:5678" and "[2001:db8::1]:443" to the bare address, so a port cannot vary the key. */
function withoutPort(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(address);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  return /^[\d.]+:\d+$/u.test(address) ? address.slice(0, address.lastIndexOf(":")) : address;
}

/** Reads a request body as text, or returns null if it exceeds MAX_BODY_BYTES. */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (request.body === null) return "";
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { config, deps, logger } = options;
  if (config.oauth !== undefined && options.auth === undefined) {
    throw new TypeError("OAuth is configured but no token verifier was supplied.");
  }
  const https = config.resourceUrl.protocol === "https:";
  // The public host is trusted only with OAuth; a no-auth server answers loopback names only,
  // so a tunnel or proxy forwarding a public Host header cannot reach it.
  const allowedHosts = [
    ...(config.oauth === undefined ? [] : [config.resourceUrl.hostname]),
    ...(config.loopback ? localhostAllowedHostnames() : []),
  ];
  const allowedOrigins = [
    ...config.allowedOrigins,
    ...(config.loopback ? localhostAllowedOrigins() : []),
  ];
  const mcp: McpHttpHandler = createMcpHandler(() => createServer(deps), {
    onerror: (error) => {
      logger.warn("mcp http handler error", { error });
    },
  });
  /** Per-user limit (by token subject) protects the operator's API quota. */
  const limiter = new RateLimiter(config.rateLimitPerMinute, options.now);
  /** Per-IP limit for public routes and failed or refused authentication (not valid tokens). */
  const ipLimiter = new RateLimiter(config.rateLimitPerMinute * PRE_AUTH_MULTIPLIER, options.now);
  /**
   * OAuth discovery has its own per-IP bucket, so junk sent from a shared client IP (for example
   * a hosted AI service) cannot stop the owner's client from discovering how to sign in again.
   */
  const metadataLimiter = new RateLimiter(
    config.rateLimitPerMinute * PRE_AUTH_MULTIPLIER,
    options.now,
  );
  const allowedSubjects = new Set(config.oauth?.allowedSubjects ?? []);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(config.resourceUrl);
  const auth = options.auth;
  const gate =
    auth === undefined || config.oauth === undefined
      ? undefined
      : requireBearerAuth({
          verifier: auth.verifier,
          requiredScopes: [...config.oauth.requiredScopes],
          resourceMetadataUrl: metadataUrl,
          expectedResource: config.resourceUrl,
        });
  const metadataOptions =
    auth === undefined || config.oauth === undefined
      ? undefined
      : {
          oauthMetadata: auth.authorizationServer,
          resourceServerUrl: config.resourceUrl,
          ...(config.oauth.requiredScopes.length > 0
            ? { scopesSupported: [...config.oauth.requiredScopes] }
            : {}),
        };

  async function route(request: Request, remoteAddress: string): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Per-IP limiting covers public routes and failed authentication, but never a valid
    // key-holder token: behind a proxy every client shares one IP, and unauthenticated junk
    // must not be able to lock the owner out.
    const ip = ipKey(remoteAddress);
    const isMetadata = path.startsWith("/.well-known/");
    if (path !== MCP_PATH && !(isMetadata ? metadataLimiter : ipLimiter).take(ip)) {
      return rateLimited();
    }
    // Liveness answers any Host and Origin (still rate-limited above), so a container health check
    // on 127.0.0.1 works while the public hostname is enforced. It reveals nothing but "ok".
    if (path === "/healthz" && request.method === "GET") return json(200, { status: "ok" });

    const hostRejected = hostHeaderValidationResponse(request, allowedHosts);
    if (hostRejected !== undefined) return hostRejected;
    const originRejected = originValidationResponse(request, allowedOrigins);
    if (originRejected !== undefined) return originRejected;

    if (metadataOptions !== undefined) {
      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata !== undefined) return metadata;
    }

    if (path !== MCP_PATH) return json(404, { error: "not_found" });

    let authInfo: AuthInfo | undefined;
    if (gate !== undefined) {
      const result = await gate(request);
      if (result instanceof Response) return ipLimiter.take(ip) ? result : rateLimited();
      authInfo = result;
      // Valid token, but only the API key holder may use this server (PCO terms clause 6).
      if (!allowedSubjects.has(subjectOf(authInfo))) {
        if (!ipLimiter.take(ip)) return rateLimited();
        return json(403, {
          error: "forbidden",
          message: "This account is not allowed to use this server.",
        });
      }
    }

    // Rate-limit per user (token subject), not per OAuth client, so new client
    // registrations cannot reset the limit.
    if (!limiter.take(subjectOf(authInfo))) return rateLimited();

    let forwarded = request;
    if (request.method === "POST") {
      const body = await readBody(request);
      if (body === null) return json(413, { error: "payload_too_large" });
      // JSON-RPC batches (allowed by older protocol revisions) would let one request carry
      // many tool calls past the rate limit; MCP no longer uses them, so refuse them.
      if (body.trimStart().startsWith("[")) {
        return json(400, {
          error: "batch_not_supported",
          message: "Send one JSON-RPC message per request.",
        });
      }
      forwarded = new Request(request, { body });
    }
    return mcp.fetch(forwarded, authInfo === undefined ? {} : { authInfo });
  }

  return {
    async fetch(request: Request, meta = { remoteAddress: "unknown" }): Promise<Response> {
      let response: Response;
      try {
        const refused =
          config.oauth === undefined
            ? unauthenticatedRejection(request, meta.remoteAddress)
            : undefined;
        response =
          refused ??
          (await route(request, clientAddress(request, meta.remoteAddress, config.trustProxy)));
      } catch (error) {
        logger.error("unhandled http error", { error });
        response = json(500, { error: "internal_error" });
      }
      return withSecurityHeaders(response, https);
    },
    close: () => mcp.close(),
  };
}
