import type { FastifyReply, FastifyRequest } from "fastify";
import type { BucketPolicy, TokenBucketLimiter } from "./tokenBucket.js";

export interface RateLimitHooks {
  onLimited?(): void;
}

/**
 * Per-API-key rate limiting. Runs after authentication, so the bucket is keyed on the key id and
 * uses each key's own policy from the database.
 *
 * Fails open: if Redis is down, requests go through and the error is logged. For a gateway in front of
 * paid LLM APIs you could argue for failing closed; failing open keeps the product up, and upstream
 * providers still enforce their own hard limits.
 */
export function makeRateLimit(limiter: TokenBucketLimiter, hooks: RateLimitHooks = {}) {
  return async function rateLimit(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.auth;
    if (!auth) throw new Error("rateLimit hook ran before authenticate");
    return enforce(req, reply, limiter, `key:${auth.apiKeyId}`, {
      capacity: auth.rateCapacity,
      refillPerSec: auth.rateRefillPerSec,
    }, hooks);
  };
}

/** Rate limit by client IP, for unauthenticated endpoints such as the public demo. */
export function makeIpRateLimit(limiter: TokenBucketLimiter, policy: BucketPolicy, hooks: RateLimitHooks = {}) {
  return async function ipRateLimit(req: FastifyRequest, reply: FastifyReply) {
    return enforce(req, reply, limiter, `ip:${req.ip}`, policy, hooks);
  };
}

async function enforce(
  req: FastifyRequest,
  reply: FastifyReply,
  limiter: TokenBucketLimiter,
  id: string,
  policy: BucketPolicy,
  hooks: RateLimitHooks,
) {
  let result;
  try {
    result = await limiter.take(id, policy);
  } catch (err) {
    req.log.error({ err }, "rate limiter unavailable, failing open");
    return;
  }

  reply.header("x-ratelimit-limit", policy.capacity);
  reply.header("x-ratelimit-remaining", result.remaining);

  if (!result.allowed) {
    hooks.onLimited?.();
    // Retry-After is whole seconds (RFC 9110); round up so a well-behaved client never retries early.
    reply.header("retry-after", Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    return reply.code(429).send({
      error: { type: "rate_limit_exceeded", message: `Rate limit exceeded. Retry in ${result.retryAfterMs} ms.` },
    });
  }
}
