// A scripted fetch double: each call takes the next step (a Response factory or an error).
import { vi } from "vitest";

export type Step = (() => Response) | Error;

export interface FakeFetch {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
}

export function fakeFetch(...steps: Step[]): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fn = vi.fn((input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (step === undefined) throw new Error("fakeFetch: no more scripted responses");
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step());
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

export const RATE_HEADERS = {
  "x-ratelimit-limit": "10000",
  "x-ratelimit-remaining": "9876",
  "x-ratelimit-reset": "1793617200",
};

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = RATE_HEADERS,
): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

export function status(code: number, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify({ error: String(code) }), { status: code, headers });
}
