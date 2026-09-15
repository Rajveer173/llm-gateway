import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashApiKey, looksLikeApiKey } from "./keys.js";

export interface AuthContext {
  apiKeyId: string;
  tenantId: string;
  rateCapacity: number;
  rateRefillPerSec: number;
  guardrails: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function readBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function unauthorized() {
  return { error: { type: "invalid_api_key", message: "Invalid or missing API key." } };
}

/**
 * Short-lived in-process cache of key lookups, so a hot key doesn't cost a Postgres query per request.
 *
 * Trade-off: a revoked key keeps working on *other* gateway instances for up to `ttlMs`. The instance
 * that handles the revoke call invalidates its own entry immediately. Only valid keys are cached;
 * caching misses would let an attacker fill memory by sending random keys.
 */
export class KeyLookupCache {
  private readonly entries = new Map<string, { ctx: AuthContext; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  get(hash: string): AuthContext | undefined {
    const hit = this.entries.get(hash);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.entries.delete(hash);
      return undefined;
    }
    return hit.ctx;
  }

  set(hash: string, ctx: AuthContext): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      // Map iterates in insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(hash, { ctx, expiresAt: Date.now() + this.ttlMs });
  }

  invalidateKeyId(apiKeyId: string): void {
    for (const [hash, entry] of this.entries) {
      if (entry.ctx.apiKeyId === apiKeyId) this.entries.delete(hash);
    }
  }
}

/**
 * Resolves `Authorization: Bearer lgw_...` to a key record. Every failure returns the same 401 body,
 * so a caller cannot tell "malformed" from "unknown" from "revoked" and probe which keys exist.
 */
export function makeAuthenticate(prisma: PrismaClient, cache: KeyLookupCache) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const key = readBearer(req);
    if (!key || !looksLikeApiKey(key)) {
      return reply.code(401).send(unauthorized());
    }

    const hash = hashApiKey(key);
    const cached = cache.get(hash);
    if (cached) {
      req.auth = cached;
      return;
    }

    // Lookup is by an indexed unique hash, so there is no per-candidate comparison for a timing attack to measure.
    const record = await prisma.apiKey.findUnique({ where: { hash } });
    if (!record || record.revokedAt) {
      return reply.code(401).send(unauthorized());
    }

    const ctx: AuthContext = {
      apiKeyId: record.id,
      tenantId: record.tenantId,
      rateCapacity: record.rateCapacity,
      rateRefillPerSec: record.rateRefillPerSec,
      guardrails: record.guardrails,
    };
    cache.set(hash, ctx);
    req.auth = ctx;
  };
}
