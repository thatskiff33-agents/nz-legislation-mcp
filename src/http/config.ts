/**
 * Configuration for HTTP (remote) mode.
 *
 * Secure by default: binds 127.0.0.1. OAuth (an external authorization server whose tokens this
 * server validates) is required whenever the server can be reached from elsewhere: a
 * non-loopback bind address OR a non-loopback public URL (e.g. a tunnel or reverse proxy in
 * front of a loopback bind). Access is limited to listed token subjects, because the PCO terms
 * (clause 6) allow only the key holder to use the key.
 */
import { z } from "zod";
import { ConfigError } from "../config.js";

/** @internal Exported for tests. */
export const HTTP_ENV = {
  host: "LEGISLATION_NZ_HTTP_HOST",
  port: "LEGISLATION_NZ_HTTP_PORT",
  publicUrl: "LEGISLATION_NZ_PUBLIC_URL",
  issuer: "LEGISLATION_NZ_OAUTH_ISSUER",
  audience: "LEGISLATION_NZ_OAUTH_AUDIENCE",
  jwksUrl: "LEGISLATION_NZ_OAUTH_JWKS_URL",
  allowedSubjects: "LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS",
  requiredScopes: "LEGISLATION_NZ_OAUTH_REQUIRED_SCOPES",
  allowedOrigins: "LEGISLATION_NZ_ALLOWED_ORIGINS",
  rateLimit: "LEGISLATION_NZ_RATE_LIMIT_PER_MINUTE",
  requireAtJwt: "LEGISLATION_NZ_OAUTH_REQUIRE_AT_JWT",
  trustProxy: "LEGISLATION_NZ_TRUST_PROXY",
} as const;

/** Path of the MCP endpoint. */
export const MCP_PATH = "/mcp";

interface OAuthConfig {
  /** Authorization server issuer identifier (exact match against token `iss`). */
  readonly issuer: URL;
  /** Expected token audience; defaults to this server's MCP URL (RFC 8707 resource). */
  readonly audience: string;
  /** JWKS URL; if omitted it is discovered from the issuer's metadata. */
  readonly jwksUrl: URL | undefined;
  /** Token subjects (`sub`) allowed to use this server: the key holder. */
  readonly allowedSubjects: readonly string[];
  readonly requiredScopes: readonly string[];
  /** Require the RFC 9068 "at+jwt" token type (off by default: not all providers set it). */
  readonly requireAtJwt: boolean;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  /** Public URL of the MCP endpoint, e.g. https://mcp.example.com/mcp. */
  readonly resourceUrl: URL;
  readonly oauth: OAuthConfig | undefined;
  /** Extra browser origins (hostnames) allowed to call the endpoint. */
  readonly allowedOrigins: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly loopback: boolean;
  /**
   * True when a reverse proxy in front of this server sets X-Forwarded-For: the client address
   * for per-IP limits is then the last address the proxy appended (not values clients send).
   */
  readonly trustProxy: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * True for loopback-only bind addresses.
 *
 * @internal Exported for tests.
 */
export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");

function parseUrl(value: string, name: string, problems: string[]): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
      problems.push(`${name} must not contain credentials, a query or a fragment.`);
      return undefined;
    }
    return url;
  } catch {
    problems.push(`${name} is not a valid URL.`);
    return undefined;
  }
}

/** Parses an optional integer in [min, max]; records a problem and returns the fallback if invalid. */
function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  message: string,
  problems: string[],
): number {
  if (raw === undefined) return fallback;
  const parsed = z.coerce.number().int().min(min).max(max).safeParse(raw);
  if (parsed.success) return parsed.data;
  problems.push(message);
  return fallback;
}

/**
 * Parses an optional true/false setting (case-insensitive). Anything else is a problem rather
 * than silently false, so a value such as "1" or "yes" cannot leave hardening switched off.
 */
function booleanSetting(raw: string | undefined, name: string, problems: string[]): boolean {
  if (raw === undefined) return false;
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  problems.push(`${name} must be true or false.`);
  return false;
}

/** Loads and checks HTTP-mode settings. Throws ConfigError listing every problem. */
export function loadHttpConfig(env: Env): HttpConfig {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === "" ? undefined : value;
  };

  const host = get(HTTP_ENV.host) ?? "127.0.0.1";
  const port = boundedInt(
    get(HTTP_ENV.port),
    8080,
    1,
    65_535,
    `${HTTP_ENV.port} must be a port number (1-65535).`,
    problems,
  );
  const rateLimitPerMinute = boundedInt(
    get(HTTP_ENV.rateLimit),
    60,
    1,
    10_000,
    `${HTTP_ENV.rateLimit} must be 1 to 10000.`,
    problems,
  );
  const loopback = isLoopback(host);
  const requireAtJwt = booleanSetting(get(HTTP_ENV.requireAtJwt), HTTP_ENV.requireAtJwt, problems);
  const trustProxy = booleanSetting(get(HTTP_ENV.trustProxy), HTTP_ENV.trustProxy, problems);

  const publicValue = get(HTTP_ENV.publicUrl);
  let resourceUrl: URL | undefined;
  if (publicValue !== undefined) {
    resourceUrl = parseUrl(publicValue, HTTP_ENV.publicUrl, problems);
    if (
      resourceUrl !== undefined &&
      resourceUrl.protocol !== "https:" &&
      (!isLoopback(resourceUrl.hostname) || !loopback)
    ) {
      problems.push(`${HTTP_ENV.publicUrl} must use https (except for a loopback-only server).`);
    }
    if (resourceUrl !== undefined && resourceUrl.pathname !== MCP_PATH) {
      problems.push(
        `${HTTP_ENV.publicUrl} must end with ${MCP_PATH}, e.g. https://mcp.example.com${MCP_PATH}.`,
      );
    }
  } else if (!loopback) {
    problems.push(
      `${HTTP_ENV.publicUrl} is required when binding to ${host} (e.g. https://mcp.example.com${MCP_PATH}).`,
    );
  }
  resourceUrl ??= new URL(`http://localhost:${String(port)}${MCP_PATH}`);

  const issuerValue = get(HTTP_ENV.issuer);
  let oauth: OAuthConfig | undefined;
  if (issuerValue !== undefined) {
    const issuer = parseUrl(issuerValue, HTTP_ENV.issuer, problems);
    if (issuer !== undefined && issuer.protocol !== "https:" && !isLoopback(issuer.hostname)) {
      problems.push(`${HTTP_ENV.issuer} must use https.`);
    }
    const jwksValue = get(HTTP_ENV.jwksUrl);
    const jwksUrl =
      jwksValue === undefined ? undefined : parseUrl(jwksValue, HTTP_ENV.jwksUrl, problems);
    if (jwksUrl !== undefined && jwksUrl.protocol !== "https:" && !isLoopback(jwksUrl.hostname)) {
      problems.push(`${HTTP_ENV.jwksUrl} must use https.`);
    }
    const allowedSubjects = list(get(HTTP_ENV.allowedSubjects));
    if (allowedSubjects.length === 0) {
      problems.push(
        `${HTTP_ENV.allowedSubjects} is required with OAuth: list the token subject(s) of the API key holder. The PCO terms do not allow anyone else to use the key.`,
      );
    }
    if (publicValue === undefined) {
      problems.push(`${HTTP_ENV.publicUrl} is required with OAuth (it is the token audience).`);
    }
    if (issuer !== undefined) {
      oauth = {
        issuer,
        audience: get(HTTP_ENV.audience) ?? resourceUrl.href,
        jwksUrl,
        allowedSubjects,
        requiredScopes: list(get(HTTP_ENV.requiredScopes)),
        requireAtJwt,
      };
    }
  } else if (!loopback || !isLoopback(resourceUrl.hostname)) {
    problems.push(
      `Remote HTTP mode requires OAuth: set ${HTTP_ENV.issuer} (and ${HTTP_ENV.allowedSubjects}), or bind to 127.0.0.1 with no public URL. A tunnel or reverse proxy in front of a loopback server is remote too. See docs/self-hosting.md.`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    host,
    port,
    resourceUrl,
    oauth,
    allowedOrigins: list(get(HTTP_ENV.allowedOrigins)),
    rateLimitPerMinute,
    loopback,
    trustProxy,
  };
}
