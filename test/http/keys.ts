// Test signing keys and token minting (real JWTs, local key set).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";

export const ISSUER = "https://auth.example.com/";
export const RESOURCE = "https://mcp.example.com/mcp";
export const SUBJECT = "user-key-holder";

export interface TestKeys {
  readonly keys: JWTVerifyGetKey;
  /**
   * Mints a token. Claims given are used as-is (even odd types, e.g. an array `sub`);
   * iss, aud and sub default to the test values, and iat to now.
   */
  readonly mint: (
    claims?: Record<string, unknown>,
    options?: { expiresIn?: string | number; alg?: string; typ?: string },
  ) => Promise<string>;
}

export async function testKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const mint: TestKeys["mint"] = (claims = {}, options = {}) => {
    const payload = {
      scope: "mcp",
      iss: ISSUER,
      aud: RESOURCE,
      sub: SUBJECT,
      iat: Math.floor(Date.now() / 1000),
      ...claims,
    };
    const header = {
      alg: options.alg ?? "ES256",
      kid: "k1",
      ...(options.typ === undefined ? {} : { typ: options.typ }),
    };
    return new SignJWT(payload)
      .setProtectedHeader(header)
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey);
  };
  return { keys, mint };
}
