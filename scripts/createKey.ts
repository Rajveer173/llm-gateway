// Usage: npm run key:create -- <tenant name> [capacity] [refillPerSec]
import { PrismaClient } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../src/auth/keys.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const [tenantName = "default", capacityArg, refillArg] = process.argv.slice(2);
const prisma = new PrismaClient();

const tenant =
  (await prisma.tenant.findFirst({ where: { name: tenantName } })) ??
  (await prisma.tenant.create({ data: { name: tenantName } }));

const { key, prefix } = generateApiKey();
await prisma.apiKey.create({
  data: {
    tenantId: tenant.id,
    name: `${tenantName} key`,
    prefix,
    hash: hashApiKey(key),
    rateCapacity: capacityArg ? Number(capacityArg) : config.DEFAULT_RATE_CAPACITY,
    rateRefillPerSec: refillArg ? Number(refillArg) : config.DEFAULT_RATE_REFILL_PER_SEC,
  },
});

console.log(`tenant: ${tenant.name} (${tenant.id})`);
console.log(`api key (shown once, store it now): ${key}`);
await prisma.$disconnect();
