import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { KeyLookupCache } from "../auth/authenticate.js";
import { generateApiKey, hashApiKey } from "../auth/keys.js";

/**
 * Compares two secrets in constant time. Hashing both first makes the buffers equal length, so the
 * comparison doesn't leak the admin token's length either.
 */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const createKeyBody = z.object({
  name: z.string().min(1).max(100).default("default"),
  rateCapacity: z.number().int().positive().max(1_000_000_000).default(20),
  rateRefillPerSec: z.number().positive().max(1_000_000_000).default(1),
  guardrails: z.boolean().default(true),
});

const usageQuery = z.object({
  tenant: z.string().min(1),
  hours: z.coerce.number().int().positive().max(24 * 90).default(24),
});

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; adminToken: string | undefined; keyCache: KeyLookupCache },
) {
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    // No admin token configured means the admin API is disabled, not open.
    if (!deps.adminToken || !secretEquals(token, deps.adminToken)) {
      return reply.code(401).send({ error: { type: "unauthorized", message: "Admin token required." } });
    }
  };

  app.post<{ Params: { tenant: string } }>(
    "/admin/tenants/:tenant/keys",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = createKeyBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: { type: "invalid_request_error", message: z.prettifyError(parsed.error) } });

      const tenant = await deps.prisma.tenant.upsert({
        where: { name: req.params.tenant },
        create: { name: req.params.tenant },
        update: {},
      });
      const { key, prefix } = generateApiKey();
      const record = await deps.prisma.apiKey.create({
        data: { tenantId: tenant.id, prefix, hash: hashApiKey(key), ...parsed.data },
      });
      return reply.code(201).send({
        id: record.id,
        tenant: tenant.name,
        prefix,
        // Returned exactly once. Only the hash is stored.
        key,
        rateCapacity: record.rateCapacity,
        rateRefillPerSec: record.rateRefillPerSec,
        guardrails: record.guardrails,
      });
    },
  );

  app.post<{ Params: { id: string } }>("/admin/keys/:id/revoke", { preHandler: requireAdmin }, async (req, reply) => {
    const updated = await deps.prisma.apiKey.updateMany({
      where: { id: req.params.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    deps.keyCache.invalidateKeyId(req.params.id);
    if (updated.count === 0) return reply.code(404).send({ error: { type: "not_found", message: "Key not found or already revoked." } });
    return { revoked: true };
  });

  app.get("/admin/usage", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = usageQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { type: "invalid_request_error", message: z.prettifyError(parsed.error) } });

    const since = new Date(Date.now() - parsed.data.hours * 3600_000);
    const rows = await deps.prisma.usageEvent.groupBy({
      by: ["model", "provider"],
      where: { createdAt: { gte: since }, apiKey: { tenant: { name: parsed.data.tenant } } },
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true },
      _avg: { latencyMs: true },
    });
    return {
      tenant: parsed.data.tenant,
      since: since.toISOString(),
      rows: rows.map((r) => ({
        model: r.model,
        provider: r.provider,
        requests: r._count._all,
        promptTokens: r._sum.promptTokens ?? 0,
        completionTokens: r._sum.completionTokens ?? 0,
        avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
      })),
    };
  });
}
