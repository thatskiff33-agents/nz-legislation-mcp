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
  readonly fetch: (request: Request) => Promise<Response>;
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

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { config, deps, logger } = options;
  if (config.oauth !== undefined && options.auth === undefined) {
    throw new TypeError("OAuth is configured but no token verifier was supplied.");
  }
  const https = config.resourceUrl.protocol === "https:";
  const allowedHosts = [
    config.resourceUrl.hostname,
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
  const limiter = new RateLimiter(config.rateLimitPerMinute, options.now);
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

  async function route(request: Request): Promise<Response> {
    const hostRejected = hostHeaderValidationResponse(request, allowedHosts);
    if (hostRejected !== undefined) return hostRejected;
    const originRejected = originValidationResponse(request, allowedOrigins);
    if (originRejected !== undefined) return originRejected;

    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") return json(200, { status: "ok" });

    if (metadataOptions !== undefined) {
      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata !== undefined) return metadata;
    }

    if (path !== MCP_PATH) return json(404, { error: "not_found" });

    let authInfo: AuthInfo | undefined;
    if (gate !== undefined) {
      const result = await gate(request);
      if (result instanceof Response) return result;
      authInfo = result;
    }

    const subject = authInfo?.clientId ?? "local";
    if (!limiter.take(subject)) {
      return json(
        429,
        { error: "rate_limited", message: "Too many requests. Wait a minute and try again." },
        { "Retry-After": "60" },
      );
    }
    return mcp.fetch(request, authInfo === undefined ? {} : { authInfo });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await route(request);
      } catch (error) {
        logger.error("unhandled http error", { error });
        response = json(500, { error: "internal_error" });
      }
      return withSecurityHeaders(response, https);
    },
    close: () => mcp.close(),
  };
}
