import { describe, expect, it } from "vitest";
import { Coalescer, MemoryCache } from "../../src/api/cache.js";

describe("MemoryCache", () => {
  it("expires entries after their TTL", () => {
    let now = 0;
    const cache = new MemoryCache(10, () => now);
    cache.set("a", 1, 100);
    expect(cache.get("a")).toBe(1);
    now = 100;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new MemoryCache(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    expect(cache.get("a")).toBe(1); // a is now most recent
    cache.set("c", 3, 1000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("replaces an existing key", () => {
    const cache = new MemoryCache(2);
    cache.set("a", 1, 1000);
    cache.set("a", 2, 1000);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
  });
});

describe("Coalescer", () => {
  it("shares in-flight work and clears it afterwards, including on failure", async () => {
    const co = new Coalescer();
    let runs = 0;
    const task = () => {
      runs += 1;
      return Promise.resolve(runs);
    };
    const [a, b] = await Promise.all([co.run("k", task), co.run("k", task)]);
    expect([a, b, runs, co.size]).toEqual([1, 1, 1, 0]);
    await expect(co.run("k", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(co.size).toBe(0);
  });
});
