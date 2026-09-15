import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { ChatRequest, ChatResult } from "../providers/types.js";

/**
 * Exact-match response cache.
 *
 * Only deterministic requests are cached (temperature 0). Serving a cached answer to a temperature-0.8
 * request would silently remove the randomness the client asked for.
 *
 * The key includes the tenant id. Without it, tenant A's cached answer to a prompt containing their
 * private data could be served to tenant B sending the same prompt: a cross-tenant data leak through
 * the cache, one of the exact attacks llm-redteam probes for.
 */
export class ResponseCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly namespace = "cache",
  ) {}

  static isCacheable(req: ChatRequest): boolean {
    return req.temperature === 0;
  }

  key(tenantId: string, req: ChatRequest): string {
    // Build the object with a fixed field order so logically identical requests hash identically.
    const normalized = JSON.stringify({
      model: req.model,
      messages: req.messages.map((m) => [m.role, m.content]),
      temperature: req.temperature ?? null,
      maxTokens: req.maxTokens ?? null,
    });
    const digest = createHash("sha256").update(normalized).digest("hex");
    return `${this.namespace}:${tenantId}:${digest}`;
  }

  async get(tenantId: string, req: ChatRequest): Promise<ChatResult | null> {
    const raw = await this.redis.get(this.key(tenantId, req));
    return raw ? (JSON.parse(raw) as ChatResult) : null;
  }

  async set(tenantId: string, req: ChatRequest, result: ChatResult): Promise<void> {
    // Truncated answers are not worth replaying.
    if (result.finishReason !== "stop") return;
    await this.redis.set(this.key(tenantId, req), JSON.stringify(result), "EX", this.ttlSeconds);
  }
}
