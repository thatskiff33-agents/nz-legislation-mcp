import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/http/rate-limit.js";

describe("RateLimiter", () => {
  it("allows a burst up to the limit, then refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect(limiter.take("b")).toBe(true); // separate key
    now += 30_000; // half a minute refills one token
    expect([limiter.take("a"), limiter.take("a")]).toEqual([true, false]);
  });

  it("bounds the number of tracked keys, dropping the oldest", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    expect(limiter.take("first")).toBe(true);
    for (let i = 0; i < 10_000; i += 1) limiter.take(`k${String(i)}`);
    // "first" was evicted, so it starts with a full bucket again.
    expect(limiter.take("first")).toBe(true);
    now += 1;
    expect(limiter.take("k9999")).toBe(false);
  });

  it("uses the real clock by default", () => {
    expect(new RateLimiter(1).take("x")).toBe(true);
  });
});
