import { readFileSync } from "node:fs";
import type { Redis, Result } from "ioredis";

const script = readFileSync(new URL("./tokenBucket.lua", import.meta.url), "utf8");

export interface BucketPolicy {
  /** Maximum burst: how many requests can go through back to back. */
  capacity: number;
  /** Sustained rate: tokens added per second. */
  refillPerSec: number;
}

export interface BucketResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      capacity: number,
      refillPerSec: number,
      cost: number,
    ): Result<[number, number, number], Context>;
  }
}

export class TokenBucketLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly namespace = "rl",
  ) {
    // defineCommand loads the script once and calls it by SHA (EVALSHA) afterwards, falling back
    // to EVAL if Redis has restarted and lost its script cache. Redefining on the same client is harmless.
    redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: script });
  }

  async take(id: string, policy: BucketPolicy, cost = 1): Promise<BucketResult> {
    const [allowed, remaining, retryAfterMs] = await this.redis.tokenBucket(
      `${this.namespace}:${id}`,
      policy.capacity,
      policy.refillPerSec,
      cost,
    );
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
