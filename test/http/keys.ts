// Test signing keys and token minting (real JWTs, local key set).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";

export const ISSUER = "https://auth.example.com/";
export const RESOURCE = "https://mcp.example.com/mcp";
export const SUBJECT = "user-key-holder";

export interface TestKeys {
  readonly keys: JWTVerifyGetKey;
  readonly mint: (
    claims?: Record<string, unknown>,
    options?: { expiresIn?: string | number; alg?: string },
  ) => Promise<string>;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

export async function testKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const mint: TestKeys["mint"] = (claims = {}, options = {}) =>
    new SignJWT({ scope: "mcp", ...claims })
      .setProtectedHeader({ alg: options.alg ?? "ES256", kid: "k1" })
      .setIssuer(text(claims["iss"], ISSUER))
      .setAudience(text(claims["aud"], RESOURCE))
      .setSubject(text(claims["sub"], SUBJECT))
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);
  return { keys, mint };
}
