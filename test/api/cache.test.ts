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

describe("MemoryCache with a size budget", () => {
  const budget = { maxWeight: 100, weigh: (value: unknown) => String(value).length };

  it("never holds more than its budget, evicting least recently used entries", () => {
    const cache = new MemoryCache(1000, Date.now, budget);
    for (let i = 0; i < 50; i += 1) {
      cache.set(`k${String(i)}`, "x".repeat(30 + (i % 7)), 1000);
      expect(cache.weight).toBeLessThanOrEqual(100);
    }
    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.get("k49")).toBe("x".repeat(30));
    expect(cache.get("k0")).toBeUndefined();
  });

  it("keeps a recently read entry over an older one", () => {
    const cache = new MemoryCache(1000, Date.now, budget);
    cache.set("a", "a".repeat(40), 1000);
    cache.set("b", "b".repeat(40), 1000);
    cache.get("a");
    cache.set("c", "c".repeat(40), 1000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("a".repeat(40));
    expect(cache.weight).toBe(80);
  });

  it("does not store a value heavier than the whole budget, and drops the old value for its key", () => {
    const cache = new MemoryCache(1000, Date.now, budget);
    cache.set("a", "small", 1000);
    cache.set("a", "y".repeat(101), 1000);
    expect(cache.get("a")).toBeUndefined();
    expect([cache.size, cache.weight]).toEqual([0, 0]);
  });

  it("releases the weight of replaced and expired entries", () => {
    let now = 0;
    const cache = new MemoryCache(1000, () => now, budget);
    cache.set("a", "x".repeat(60), 10);
    cache.set("a", "x".repeat(20), 10);
    expect(cache.weight).toBe(20);
    now = 10;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.weight).toBe(0);
  });

  it("weighs nothing without a budget", () => {
    const cache = new MemoryCache(2);
    cache.set("a", "x".repeat(1000), 1000);
    expect(cache.weight).toBe(0);
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
