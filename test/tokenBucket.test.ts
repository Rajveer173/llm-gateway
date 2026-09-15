import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/ratelimit/tokenBucket.js";

// Integration test: runs the real Lua script against a real Redis (docker compose up redis).
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

describe("TokenBucketLimiter (Redis)", () => {
  let redis: Redis;
  let limiter: TokenBucketLimiter;
  const namespace = `test:${randomUUID()}`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    limiter = new TokenBucketLimiter(redis, namespace);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("allows exactly `capacity` requests in a burst, then rejects", async () => {
    const policy = { capacity: 5, refillPerSec: 0.001 };
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await limiter.take("burst", policy));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(results[4]!.remaining).toBe(0);
    expect(results[5]!.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time at the configured rate", async () => {
    const policy = { capacity: 2, refillPerSec: 10 }; // one token every 100 ms
    await limiter.take("refill", policy);
    await limiter.take("refill", policy);
    expect((await limiter.take("refill", policy)).allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect((await limiter.take("refill", policy)).allowed).toBe(true);
  });

  it("is atomic under concurrency: 50 parallel requests on a 10-token bucket admit exactly 10", async () => {
    const policy = { capacity: 10, refillPerSec: 0.001 };
    // A second connection makes the race real: requests arrive over two sockets, like two gateway instances.
    const other = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const otherLimiter = new TokenBucketLimiter(other, namespace);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 === 0 ? limiter : otherLimiter).take("concurrent", policy),
      ),
    );
    await other.quit();

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("keeps separate buckets per key", async () => {
    const policy = { capacity: 1, refillPerSec: 0.001 };
    expect((await limiter.take("key-a", policy)).allowed).toBe(true);
    expect((await limiter.take("key-a", policy)).allowed).toBe(false);
    expect((await limiter.take("key-b", policy)).allowed).toBe(true);
  });
});
