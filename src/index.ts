import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PrismaUsageSink } from "./metering/prismaSink.js";
import { UsageMeter } from "./metering/usageMeter.js";
import { Metrics } from "./observability/metrics.js";
import { MockProvider } from "./providers/mock.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { ProviderRouter } from "./providers/router.js";
import type { Provider } from "./providers/types.js";

const config = loadConfig();
const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const metrics = new Metrics();

const providers = new Map<string, Provider>();
if (config.OLLAMA_URL) providers.set("ollama", new OllamaProvider(config.OLLAMA_URL));
if (config.GEMINI_API_KEY) providers.set("gemini", new OpenAICompatibleProvider("gemini", config.GEMINI_BASE_URL, config.GEMINI_API_KEY));
if (config.OPENAI_API_KEY) providers.set("openai", new OpenAICompatibleProvider("openai", config.OPENAI_BASE_URL, config.OPENAI_API_KEY));
if (config.MOCK_PROVIDER)
  providers.set(
    "mock",
    new MockProvider("mock", config.MOCK_LATENCY_MS, 20, config.MOCK_LEAK_SECRET ?? (config.DEMO_ENABLED ? config.DEMO_SECRET : undefined)),
  );

const router = new ProviderRouter(
  providers,
  config.routes,
  { failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD, cooldownMs: config.CIRCUIT_COOLDOWN_MS },
  { onAttempt: (provider, outcome) => metrics.providerAttempts.inc({ provider, outcome }) },
);

const meter = new UsageMeter(new PrismaUsageSink(prisma), {
  flushIntervalMs: config.METER_FLUSH_MS,
  maxBatchSize: 500,
  maxBuffered: 50_000,
  onError: (err, n) => app.log.error({ err, batch: n }, "usage flush failed, will retry"),
  onDrop: (n) => metrics.usageDropped.inc(n),
});

const app = buildApp({
  prisma,
  redis,
  provider: router,
  meter,
  metrics,
  guardrails: { canaries: config.canaryList, blockInjectionPatterns: config.BLOCK_INJECTION_PATTERNS },
  cacheTtlSeconds: config.CACHE_TTL_SECONDS,
  authCacheTtlMs: config.AUTH_CACHE_TTL_MS,
  adminToken: config.ADMIN_TOKEN,
  metricsToken: config.METRICS_TOKEN,
  models: config.routes.map((r) => r.modelPrefix).filter(Boolean),
  demo: config.DEMO_ENABLED
    ? {
        models: config.DEMO_MODELS.split(",").map((s) => s.trim()).filter(Boolean),
        rateCapacity: config.DEMO_RATE_CAPACITY,
        rateRefillPerSec: config.DEMO_RATE_REFILL_PER_SEC,
        maxTokens: config.DEMO_MAX_TOKENS,
        secret: config.DEMO_SECRET,
      }
    : undefined,
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
});

meter.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  // Stop accepting connections, let in-flight requests finish, flush usage, then close dependencies.
  await app.close();
  await meter.stop();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
app.log.info({ providers: [...providers.keys()], routes: config.routes.map((r) => r.modelPrefix || "*") }, "gateway ready");
