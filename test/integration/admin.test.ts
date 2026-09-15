import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { PrismaUsageSink } from "../../src/metering/prismaSink.js";
import { UsageMeter } from "../../src/metering/usageMeter.js";
import { MockProvider } from "../../src/providers/mock.js";
import { ProviderRouter } from "../../src/providers/router.js";

// Full stack against real Postgres and Redis. Runs in CI (service containers) or locally with
// `npm run devdb` + Redis, when INTEGRATION=1.
const enabled = process.env.INTEGRATION === "1";
const ADMIN = "integration-admin-token-0123456789";

describe.runIf(enabled)("admin API + metering (Postgres)", () => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: 1 });
  const meter = new UsageMeter(new PrismaUsageSink(prisma), { flushIntervalMs: 60_000, maxBatchSize: 100, maxBuffered: 1000 });
  const tenant = `it-${Date.now()}`;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const router = new ProviderRouter(new Map([["mock", new MockProvider("mock", 0)]]), [{ modelPrefix: "", providers: ["mock"] }], { failureThreshold: 3, cooldownMs: 1000 });
    app = buildApp({ prisma, redis, provider: router, meter, adminToken: ADMIN, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  const admin = { authorization: `Bearer ${ADMIN}` };

  it("rejects admin calls without the admin token", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/tenants/${tenant}/keys`, headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("creates a key, meters usage, reports it, and revokes the key", async () => {
    const created = await app.inject({ method: "POST", url: `/admin/tenants/${tenant}/keys`, headers: admin, payload: { rateCapacity: 10, rateRefillPerSec: 1 } });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(stored.hash).not.toContain(key);

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        payload: { model: "mock", messages: [{ role: "user", content: `hello ${i}` }] },
      });
      expect(res.statusCode).toBe(200);
    }
    await meter.flush();

    const usage = await app.inject({ method: "GET", url: `/admin/usage?tenant=${tenant}`, headers: admin });
    expect(usage.json().rows).toEqual([expect.objectContaining({ model: "mock", provider: "mock", requests: 3 })]);

    const revoke = await app.inject({ method: "POST", url: `/admin/keys/${id}/revoke`, headers: admin });
    expect(revoke.statusCode).toBe(200);
    const after = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "mock", messages: [{ role: "user", content: "hi" }] } });
    expect(after.statusCode).toBe(401);
  });
});
