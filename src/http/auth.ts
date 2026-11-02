/**
 * OAuth 2.1 resource-server pieces: authorization-server discovery and JWT access-token
 * verification. This server never issues tokens and never forwards them anywhere.
 */
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/** Asymmetric algorithms accepted for access tokens (no "none", no HMAC shared secrets). */
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];
const CLOCK_TOLERANCE_SECONDS = 30;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** The parts of RFC 8414 / OIDC discovery metadata this server relies on. */
const AuthorizationServerMetadataSchema = z
  .object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    jwks_uri: z.url().optional(),
    response_types_supported: z.array(z.string()).optional(),
  })
  .loose();

export type AuthorizationServerMetadata = z.output<typeof AuthorizationServerMetadataSchema> & {
  response_types_supported: string[];
};

/**
 * Fetches the authorization server's metadata: RFC 8414 first, then OpenID Connect discovery.
 * The returned `issuer` must equal the configured issuer exactly (mix-up defence).
 */
export async function discoverAuthorizationServer(
  issuer: URL,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<AuthorizationServerMetadata> {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/u, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
  ];
  const problems: string[] = [];
  for (const url of candidates) {
    try {
      const response = await fetchFn(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        problems.push(`${url.href}: HTTP ${String(response.status)}`);
        continue;
      }
      const parsed = AuthorizationServerMetadataSchema.safeParse(await response.json());
      if (!parsed.success) {
        problems.push(`${url.href}: not valid authorization server metadata`);
        continue;
      }
      if (
        parsed.data.issuer !== issuer.href &&
        parsed.data.issuer !== issuer.href.replace(/\/$/u, "")
      ) {
        throw new Error(
          `The authorization server says its issuer is ${parsed.data.issuer}, not ${issuer.href}. Check LEGISLATION_NZ_OAUTH_ISSUER.`,
        );
      }
      return {
        ...parsed.data,
        response_types_supported: parsed.data.response_types_supported ?? ["code"],
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The authorization server says"))
        throw error;
      problems.push(`${url.href}: unreachable`);
    }
  }
  throw new Error(`Could not discover the authorization server metadata (${problems.join("; ")}).`);
}

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedSubjects: readonly string[];
  /** This server's resource URL, stamped on verified tokens (RFC 8707 resource binding). */
  readonly resource: URL;
  /** Key source: a remote JWKS in production, a local key set in tests. */
  readonly keys: JWTVerifyGetKey;
}

/** Builds a key source from a JWKS URL (keys are cached and refreshed by jose). */
export function remoteKeys(jwksUrl: URL): JWTVerifyGetKey {
  return createRemoteJWKSet(jwksUrl, {
    timeoutDuration: DISCOVERY_TIMEOUT_MS,
    cooldownDuration: 30_000,
  });
}

const invalid = (message: string): OAuthError =>
  new OAuthError(OAuthErrorCode.InvalidToken, message);

/** Verifies signed JWT access tokens and limits access to the allowed subjects. */
export function createJwtVerifier(options: JwtVerifierOptions): OAuthTokenVerifier {
  const allowed = new Set(options.allowedSubjects);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "sub"],
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) throw invalid("The access token has expired.");
        throw invalid("The access token is not valid for this server.");
      }
      const subject = String(payload.sub);
      if (!allowed.has(subject)) {
        throw invalid(
          "This account is not allowed to use this server (only the API key holder may).",
        );
      }
      const scopeClaim = payload["scope"];
      const scpClaim = payload["scp"];
      const scopes =
        typeof scopeClaim === "string"
          ? scopeClaim.split(" ").filter((s) => s !== "")
          : Array.isArray(scpClaim)
            ? scpClaim.filter((s): s is string => typeof s === "string")
            : [];
      // The client identifier: client_id (RFC 9068) or azp (OIDC), else the subject.
      const clientId =
        [payload["client_id"], payload["azp"]].find((c): c is string => typeof c === "string") ??
        subject;
      return {
        token,
        clientId,
        scopes,
        expiresAt: Number(payload.exp),
        // The audience check above binds the token to this server.
        resource: options.resource,
      };
    },
  };
}
