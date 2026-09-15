import "dotenv/config";
import { z } from "zod";
import type { Route } from "./providers/router.js";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // Providers: each is enabled when its setting is present.
  OLLAMA_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai"),
  MOCK_PROVIDER: bool.default(false),
  MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(50),
  /** JSON array of routes. When unset, a default is derived from the enabled providers. */
  ROUTES_JSON: z.string().optional(),

  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),

  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).default(10_000),
  METER_FLUSH_MS: z.coerce.number().int().positive().default(1000),

  /** Comma-separated strings that must never appear in model output. */
  CANARIES: z.string().default(""),
  BLOCK_INJECTION_PATTERNS: bool.default(true),

  ADMIN_TOKEN: z.string().min(24).optional(),
  METRICS_TOKEN: z.string().min(16).optional(),

  DEMO_ENABLED: bool.default(false),
  DEMO_MODELS: z.string().default("fast"),
  DEMO_RATE_CAPACITY: z.coerce.number().int().positive().default(8),
  DEMO_RATE_REFILL_PER_SEC: z.coerce.number().positive().default(0.1),
  DEMO_MAX_TOKENS: z.coerce.number().int().positive().default(300),
  /** Planted in the demo's hidden system prompt so visitors can try to make the model leak it. */
  DEMO_SECRET: z.string().default("CANARY-DEMO-7F3A"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof schema> & { routes: Route[]; canaryList: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Fail at boot, not on the first request that happens to touch a missing variable.
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  const canaryList = c.CANARIES.split(",").map((s) => s.trim()).filter(Boolean);
  if (c.DEMO_ENABLED && !canaryList.includes(c.DEMO_SECRET)) canaryList.push(c.DEMO_SECRET);
  return { ...c, routes: c.ROUTES_JSON ? parseRoutes(c.ROUTES_JSON) : defaultRoutes(c), canaryList };
}

function parseRoutes(json: string): Route[] {
  const route = z.object({
    modelPrefix: z.string(),
    providers: z.array(z.string()).min(1),
    modelMap: z.record(z.string(), z.string()).optional(),
  });
  return z.array(route).min(1).parse(JSON.parse(json));
}

/**
 * Default routing:
 * - "gpt-*" → openai, "gemini-*" → gemini: pass-through to the named vendor.
 * - "fast"  → a portable alias. Each provider maps it to its own small model, which is what makes
 *   cross-provider fallback possible: "qwen2.5:0.5b" means nothing to Gemini, but "fast" means something
 *   to every provider.
 * - anything else → ollama (local model names like "llama3" or "qwen2.5:0.5b").
 */
function defaultRoutes(c: z.infer<typeof schema>): Route[] {
  const enabled = [
    c.OLLAMA_URL && "ollama",
    c.GEMINI_API_KEY && "gemini",
    c.OPENAI_API_KEY && "openai",
    c.MOCK_PROVIDER && "mock",
  ].filter(Boolean) as string[];
  if (enabled.length === 0) throw new Error("No providers enabled: set OLLAMA_URL, GEMINI_API_KEY, OPENAI_API_KEY or MOCK_PROVIDER=true");

  const routes: Route[] = [
    {
      modelPrefix: "fast",
      providers: enabled,
      modelMap: { ollama: "qwen2.5:0.5b", gemini: "gemini-2.0-flash-lite", openai: "gpt-4o-mini", mock: "mock-fast" },
    },
  ];
  if (c.OPENAI_API_KEY) routes.push({ modelPrefix: "gpt-", providers: ["openai"] });
  if (c.GEMINI_API_KEY) routes.push({ modelPrefix: "gemini-", providers: ["gemini"] });
  if (c.MOCK_PROVIDER) routes.push({ modelPrefix: "mock", providers: ["mock"] });
  if (c.OLLAMA_URL) routes.push({ modelPrefix: "", providers: ["ollama"] });
  return routes;
}
