// Transport behaviour against a real local HTTP server through real fetch (undici):
// body-phase timeouts, decompression bombs and redirects.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LegislationClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import { Secret } from "../../src/secret.js";

const KEY = "local-test-key-0123456789";
const VERSION_ID = "act_public_2007_97_en_2026-09-04";
let server: Server;
let base = "";
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    hits[path] = (hits[path] ?? 0) + 1;
    if (path.includes("stall")) {
      // Send headers and part of the body, then stall.
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"title":');
      return;
    }
    if (path.includes("bomb")) {
      const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20)); // 50 MB of spaces
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(bomb);
      return;
    }
    if (path.includes("redirect")) {
      res.writeHead(302, { location: `${base}/target` });
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

/** Real fetch, re-pointed from the API origin to the local server for one scenario. */
function clientFor(
  scenario: string,
  extra: Partial<ConstructorParameters<typeof LegislationClient>[0]> = {},
) {
  const fetchToLocal: typeof fetch = (input, init) =>
    fetch(
      `${base}/${scenario}${new URL(input instanceof Request ? input.url : input).pathname}`,
      init,
    );
  return new LegislationClient({
    apiKey: new Secret(KEY),
    timeoutMs: 300,
    fetch: fetchToLocal,
    ...extra,
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const e = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  return e instanceof ApiError ? e.kind : `not an ApiError: ${String(e)}`;
}

describe("real transport", () => {
  it("classifies a body that stalls mid-download as a timeout and does not retry", async () => {
    const c = clientFor("stall");
    expect(await kindOf(c.getVersion(VERSION_ID))).toBe("timeout");
    expect(hits[`/stall/v0/versions/${VERSION_ID}/`]).toBe(1);
  });

  it("stops a gzip decompression bomb at the byte cap", async () => {
    const c = clientFor("bomb", { maxBodyBytes: 1024 * 1024, timeoutMs: 5000 });
    expect(await kindOf(c.getVersion(VERSION_ID))).toBe("response_too_large");
  });

  it("does not follow redirects", async () => {
    const c = clientFor("redirect");
    expect(await kindOf(c.getVersion(VERSION_ID))).toBe("unexpected_redirect");
    expect(hits["/target"]).toBeUndefined();
  });
});
