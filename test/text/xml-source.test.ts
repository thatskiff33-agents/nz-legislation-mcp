import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { ToolInputError } from "../../src/tools/shared.js";
import { assertWebsiteUrl, streamVersionXml, xmlUrlFor } from "../../src/text/xml-source.js";
import { fakeFetch, type Step } from "../api/fake-fetch.js";

const ID = "act_public_1976_33_en_2014-01-01";
const signal = new AbortController().signal;

async function collect(gen: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

async function kind(promise: Promise<unknown>): Promise<string> {
  const e = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  return e instanceof ApiError ? e.kind : String(e);
}

const xmlResponse =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status });

describe("xmlUrlFor", () => {
  it("builds the dated XML URL on the official website", () => {
    expect(xmlUrlFor(ID).toString()).toBe(
      "https://www.legislation.govt.nz/act/public/1976/33/en/2014-01-01.xml",
    );
  });

  it("refuses any other host", () => {
    expect(() => assertWebsiteUrl(new URL("https://evil.example/x.xml"))).toThrow(TypeError);
    expect(() => assertWebsiteUrl(new URL("http://www.legislation.govt.nz/x.xml"))).toThrow(
      TypeError,
    );
  });

  it("refuses agency-published (provisional) records and invalid ids", () => {
    expect(() =>
      xmlUrlFor("secondary-legislation_agency-drafted_~2026_~346285_en_~2026-10-30"),
    ).toThrow(ToolInputError);
    expect(() => xmlUrlFor("nonsense")).toThrow(ToolInputError);
  });
});

describe("streamVersionXml", () => {
  it("streams the body with no key, no redirects and no credentials", async () => {
    const fake = fakeFetch(xmlResponse("<act>ok</act>"));
    expect(await collect(streamVersionXml(ID, signal, { fetch: fake.fn }))).toBe("<act>ok</act>");
    const init = fake.calls[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    expect(JSON.stringify(init?.headers)).not.toMatch(/api-key/i);
    expect(fake.calls[0]?.url).toBe(
      "https://www.legislation.govt.nz/act/public/1976/33/en/2014-01-01.xml",
    );
  });

  it.each<[number, string]>([
    [404, "not_found"],
    [302, "unexpected_redirect"],
    [503, "upstream_unavailable"],
    [500, "upstream_error"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    const fake = fakeFetch(xmlResponse("", status));
    expect(await kind(collect(streamVersionXml(ID, signal, { fetch: fake.fn })))).toBe(expected);
  });

  it("tolerates a body that cannot be cancelled on an error status", async () => {
    const stubborn: Step = () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("no");
          },
        }),
        { status: 404 },
      );
    const fake = fakeFetch(stubborn);
    expect(await kind(collect(streamVersionXml(ID, signal, { fetch: fake.fn })))).toBe("not_found");
  });

  it("rejects an empty 200 response", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200 }));
    expect(await kind(collect(streamVersionXml(ID, signal, { fetch: fake.fn })))).toBe(
      "invalid_response",
    );
  });

  it("enforces the byte cap while streaming", async () => {
    const fake = fakeFetch(xmlResponse("x".repeat(5000)));
    expect(
      await kind(collect(streamVersionXml(ID, signal, { fetch: fake.fn, maxBytes: 1000 }))),
    ).toBe("response_too_large");
  });

  it("classifies network errors, timeouts and caller cancellation", async () => {
    expect(
      await kind(
        collect(streamVersionXml(ID, signal, { fetch: fakeFetch(new TypeError("down")).fn })),
      ),
    ).toBe("network");
    const timeout = new DOMException("t", "TimeoutError");
    expect(
      await kind(collect(streamVersionXml(ID, signal, { fetch: fakeFetch(timeout).fn }))),
    ).toBe("timeout");
    const controller = new AbortController();
    controller.abort();
    expect(
      await kind(
        collect(
          streamVersionXml(ID, controller.signal, {
            fetch: fakeFetch(new DOMException("a", "AbortError")).fn,
          }),
        ),
      ),
    ).toBe("cancelled");
  });

  it("classifies a failure while reading the body", async () => {
    const broken: Step = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("reset"));
          },
        }),
        { status: 200 },
      );
    expect(await kind(collect(streamVersionXml(ID, signal, { fetch: fakeFetch(broken).fn })))).toBe(
      "network",
    );
  });

  it("releases the stream when the consumer stops early", async () => {
    const cancel = vi.fn();
    const endless: Step = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("<a>"));
          },
          cancel,
        }),
        { status: 200 },
      );
    for await (const chunk of streamVersionXml(ID, signal, { fetch: fakeFetch(endless).fn })) {
      expect(chunk).toBe("<a>");
      break;
    }
    expect(cancel).toHaveBeenCalled();
  });

  it("flushes an incomplete UTF-8 sequence at the end as a replacement character", async () => {
    const truncated: Step = () =>
      new Response(new Uint8Array([0x3c, 0x61, 0x3e, 0xe2, 0x82]), { status: 200 });
    expect(await collect(streamVersionXml(ID, signal, { fetch: fakeFetch(truncated).fn }))).toBe(
      "<a>\uFFFD",
    );
  });

  it("uses global fetch by default", async () => {
    vi.stubGlobal("fetch", fakeFetch(xmlResponse("<act/>")).fn);
    expect(await collect(streamVersionXml(ID, signal))).toBe("<act/>");
  });
});
