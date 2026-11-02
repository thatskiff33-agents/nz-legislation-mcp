import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listen } from "../../src/http/node.js";
import { silentLogger } from "../../src/logger.js";

let server: Server | undefined;
afterEach(async () => {
  const current = server;
  server = undefined;
  if (current === undefined) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => {
    current.close(() => {
      resolve();
    });
  });
});

const base = () => `http://127.0.0.1:${String((server?.address() as AddressInfo).port)}`;

describe("listen", () => {
  it("passes method, path, headers and streamed body through, and streams the response", async () => {
    server = await listen(
      async (request) => {
        const body = await request.text();
        return new Response(
          JSON.stringify({
            method: request.method,
            path: new URL(request.url).pathname,
            host: request.headers.get("host"),
            multi: request.headers.get("x-multi"),
            body,
          }),
          { status: 201, headers: { "x-test": "yes" } },
        );
      },
      { host: "127.0.0.1", port: 0, logger: silentLogger },
    );
    const res = await fetch(`${base()}/mcp?x=1`, {
      method: "POST",
      body: "hello",
      headers: { "x-multi": "a" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("yes");
    expect(await res.json()).toMatchObject({
      method: "POST",
      path: "/mcp",
      body: "hello",
      multi: "a",
    });
  });

  it("handles GET with no body and empty responses", async () => {
    server = await listen(() => Promise.resolve(new Response(null, { status: 204 })), {
      host: "127.0.0.1",
      port: 0,
      logger: silentLogger,
    });
    expect((await fetch(`${base()}/healthz`)).status).toBe(204);
  });

  it("returns 500 when the handler fails, and logs it", async () => {
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      error: (m: string) => {
        lines.push(m);
      },
    };
    server = await listen(() => Promise.reject(new Error("boom")), {
      host: "127.0.0.1",
      port: 0,
      logger,
    });
    expect((await fetch(`${base()}/`)).status).toBe(500);
    expect(lines).toContain("http response failed");
  });

  it("ends the response if the body fails part-way (headers already sent)", async () => {
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      error: (m: string) => {
        lines.push(m);
      },
    };
    server = await listen(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("partial"));
                c.error(new Error("broken"));
              },
            }),
            { status: 200 },
          ),
        ),
      { host: "127.0.0.1", port: 0, logger },
    );
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    await res.text().catch(() => "");
    expect(lines).toContain("http response failed");
  });

  it("aborts the request signal when the client disconnects", async () => {
    let aborted: Promise<boolean> = Promise.resolve(false);
    server = await listen(
      (request) => {
        aborted = new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            resolve(true);
          });
        });
        return new Promise(() => undefined); // never answers
      },
      { host: "127.0.0.1", port: 0, logger: silentLogger },
    );
    const controller = new AbortController();
    const pending = fetch(`${base()}/slow`, { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await pending;
    expect(await aborted).toBe(true);
  });

  it("rejects when the port is unavailable", async () => {
    server = await listen(() => Promise.resolve(new Response("x")), {
      host: "127.0.0.1",
      port: 0,
      logger: silentLogger,
    });
    const port = (server.address() as AddressInfo).port;
    await expect(
      listen(() => Promise.resolve(new Response("x")), {
        host: "127.0.0.1",
        port,
        logger: silentLogger,
      }),
    ).rejects.toThrow();
  });
});
