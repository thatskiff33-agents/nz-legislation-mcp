import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { drainedOrClosed, listen } from "../../src/http/node.js";
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

  it("streams a large response (respecting backpressure)", async () => {
    const size = 16 * 1024 * 1024;
    server = await listen(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                for (let i = 0; i < 16; i += 1) c.enqueue(new Uint8Array(size / 16).fill(0x61));
                c.close();
              },
            }),
          ),
        ),
      { host: "127.0.0.1", port: 0, logger: silentLogger },
    );
    const body = await (await fetch(`${base()}/big`)).arrayBuffer();
    expect(body.byteLength).toBe(size);
  });

  it("stops and releases the body when a stalled client disconnects", async () => {
    let cancelled!: () => void;
    const released = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    server = await listen(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              // An endless body: only a cancel ends it.
              pull(c) {
                c.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
              },
              cancel() {
                cancelled();
              },
            }),
          ),
        ),
      { host: "127.0.0.1", port: 0, logger: silentLogger },
    );
    // A raw client that sends a request, never reads, then goes away.
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1");
    socket.pause();
    socket.write("GET /stall HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    socket.destroy();
    await released; // would hang (test timeout) if the writer waited for "drain" for ever
  });

  it("cancels the body when the client goes while the producer is waiting", async () => {
    let cancelled!: () => void;
    const released = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    server = await listen(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([0x61])); // then never another chunk
              },
              cancel() {
                cancelled();
              },
            }),
          ),
        ),
      { host: "127.0.0.1", port: 0, logger: silentLogger },
    );
    const controller = new AbortController();
    const response = await fetch(`${base()}/idle`, { signal: controller.signal });
    expect(response.status).toBe(200);
    controller.abort();
    await released;
  });

  it("does not wait for drain on a response that is already closed", async () => {
    const closed = { destroyed: true } as unknown as Parameters<typeof drainedOrClosed>[0];
    expect(await drainedOrClosed(closed)).toBe(false);
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

  it("survives malformed request lines and unsupported methods (no crash)", async () => {
    server = await listen(() => Promise.resolve(new Response("ok")), {
      host: "127.0.0.1",
      port: 0,
      logger: silentLogger,
    });
    const port = (server.address() as AddressInfo).port;
    const raw = (line: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        socket.on("data", (d: Buffer) => (data += d.toString()));
        socket.on("close", () => {
          resolve(data.split("\r\n")[0] ?? "");
        });
        socket.on("error", () => {
          resolve("error");
        });
      });
    expect(await raw("TRACE / HTTP/1.1")).toContain("405");
    for (const line of [
      "GET http:// HTTP/1.1",
      "GET http://[/ HTTP/1.1",
      "GET http://a:99999/ HTTP/1.1",
      "GET http://%zz/ HTTP/1.1",
    ]) {
      const status = await raw(line);
      expect(status === "error" || /HTTP\/1\.1 (400|200)/u.test(status)).toBe(true);
    }
    // Still alive afterwards.
    expect((await fetch(`${base()}/`)).status).toBe(200);
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
