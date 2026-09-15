import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../auth/authenticate.js";
import { ResponseCache } from "../cache/responseCache.js";
import {
  type GuardrailConfig,
  LEAK_REFUSAL,
  StreamingCanaryFilter,
  checkInput,
  findCanary,
} from "../guardrails/guardrails.js";
import type { UsageMeter } from "../metering/usageMeter.js";
import type { Metrics } from "../observability/metrics.js";
import {
  type ChatRequest,
  type Provider,
  type StreamChunk,
  UpstreamClientError,
  UpstreamError,
} from "../providers/types.js";

// OpenAI-compatible request body, so existing OpenAI SDKs work by changing only the base URL.
export const chatBody = z.object({
  model: z.string().min(1).max(200),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().max(100_000),
      }),
    )
    .min(1)
    .max(200),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  stream: z.boolean().optional(),
});

export interface ChatDeps {
  provider: Provider;
  cache: ResponseCache;
  meter: UsageMeter;
  metrics: Metrics;
  guardrails: GuardrailConfig;
}

const completionId = () => `chatcmpl-${randomUUID()}`;

function errorBody(type: string, message: string) {
  return { error: { type, message } };
}

/**
 * Shared handler for authenticated API calls and the public demo. `auth` decides the tenant (cache
 * scope), metering identity and whether guardrails apply.
 */
export async function handleChat(req: FastifyRequest, reply: FastifyReply, auth: AuthContext, deps: ChatDeps) {
  const started = performance.now();
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(errorBody("invalid_request_error", z.prettifyError(parsed.error)));
  }
  const body = parsed.data;
  const chatReq: ChatRequest = {
    model: body.model,
    messages: body.messages,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
  };
  const guardrailsOn = auth.guardrails;

  if (guardrailsOn) {
    const verdict = checkInput(chatReq.messages, deps.guardrails);
    if (verdict.blocked) {
      deps.metrics.guardrailBlocks.inc({ stage: "input", rule: verdict.rule });
      reply.header("x-guardrail", `input_blocked:${verdict.rule}`);
      return reply.code(400).send(errorBody("guardrail_blocked", "Request blocked by content policy."));
    }
  }

  // Abort the upstream call when the client disconnects, so we stop paying for tokens nobody reads.
  // Listen on the *response*: the request stream's 'close' fires as soon as the body has been read.
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort(new Error("client disconnected"));
  });

  const meter = (m: { model: string; provider: string; promptTokens: number; completionTokens: number; status: number; cached: boolean }) => {
    const latencyMs = Math.round(performance.now() - started);
    deps.meter.record({ apiKeyId: auth.apiKeyId, latencyMs, createdAt: new Date(), ...m });
    deps.metrics.requestDuration.observe(
      { route: "chat", status: String(m.status), stream: String(!!body.stream), cache: m.cached ? "hit" : "miss" },
      latencyMs / 1000,
    );
    if (!m.cached) {
      deps.metrics.tokens.inc({ provider: m.provider, direction: "prompt" }, m.promptTokens);
      deps.metrics.tokens.inc({ provider: m.provider, direction: "completion" }, m.completionTokens);
    }
  };

  const failure = (err: unknown) => {
    if (err instanceof UpstreamClientError) {
      return reply.code(400).send(errorBody("invalid_request_error", `Upstream rejected the request (${err.status}).`));
    }
    if (err instanceof UpstreamError) {
      req.log.warn({ err: err.message }, "upstream failure");
      return reply.code(502).send(errorBody("upstream_error", "All providers failed for this model."));
    }
    throw err;
  };

  if (body.stream) {
    return streamChat(req, reply, auth, deps, chatReq, controller, started, meter, failure);
  }

  // ---- non-streaming ----
  const cacheable = ResponseCache.isCacheable(chatReq);
  if (cacheable) {
    const hit = await deps.cache.get(auth.tenantId, chatReq).catch(() => null);
    deps.metrics.cacheLookups.inc({ result: hit ? "hit" : "miss" });
    if (hit) {
      reply.header("x-cache", "HIT");
      meter({ model: hit.model, provider: hit.provider, promptTokens: hit.promptTokens, completionTokens: hit.completionTokens, status: 200, cached: true });
      return completionResponse(hit.model, hit.content, hit.finishReason, hit.promptTokens, hit.completionTokens);
    }
  }
  reply.header("x-cache", cacheable ? "MISS" : "BYPASS");

  let result;
  try {
    result = await deps.provider.chat(chatReq, controller.signal);
  } catch (err) {
    return failure(err);
  }

  let content = result.content;
  let finishReason: string = result.finishReason;
  const leaked = guardrailsOn ? findCanary(content, deps.guardrails.canaries) : undefined;
  if (leaked) {
    deps.metrics.guardrailBlocks.inc({ stage: "output", rule: "canary" });
    reply.header("x-guardrail", "output_blocked:canary");
    content = LEAK_REFUSAL;
    finishReason = "content_filter";
  } else if (cacheable) {
    await deps.cache.set(auth.tenantId, chatReq, result).catch((err) => req.log.warn({ err }, "cache write failed"));
  }

  reply.header("x-provider", result.provider);
  meter({ model: result.model, provider: result.provider, promptTokens: result.promptTokens, completionTokens: result.completionTokens, status: 200, cached: false });
  return completionResponse(result.model, content, finishReason, result.promptTokens, result.completionTokens);
}

function completionResponse(model: string, content: string, finishReason: string, promptTokens: number, completionTokens: number) {
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

async function streamChat(
  req: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContext,
  deps: ChatDeps,
  chatReq: ChatRequest,
  controller: AbortController,
  started: number,
  meter: (m: { model: string; provider: string; promptTokens: number; completionTokens: number; status: number; cached: boolean }) => void,
  failure: (err: unknown) => unknown,
) {
  const iterator = deps.provider.chatStream(chatReq, controller.signal)[Symbol.asyncIterator]();

  // Wait for the first chunk *before* sending headers. Until then, provider failures (and fallback)
  // can still produce a normal JSON error with the right status code. After headers go out, the status
  // is locked at 200 and errors can only be reported inside the stream.
  let first: IteratorResult<StreamChunk>;
  try {
    first = await iterator.next();
  } catch (err) {
    return failure(err);
  }

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let model = chatReq.model;
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Stops nginx-style proxies from buffering the stream into one late blob.
    "x-accel-buffering": "no",
    "x-cache": "BYPASS",
    ...Object.fromEntries(
      Object.entries(reply.getHeaders()).filter(([k]) => k.startsWith("x-ratelimit")),
    ),
  });

  const send = async (payload: unknown) => {
    // Backpressure: if the client reads slower than the model writes, write() returns false once the
    // socket buffer is full. Waiting for 'drain' stops us from buffering the whole answer in memory.
    if (!raw.write(`data: ${JSON.stringify(payload)}\n\n`)) {
      await Promise.race([once(raw, "drain"), once(raw, "close")]);
    }
  };
  const chunk = (delta: Record<string, string>, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const filter = auth.guardrails ? new StreamingCanaryFilter(deps.guardrails.canaries) : undefined;
  let firstTokenSeen = false;
  let done: Extract<StreamChunk, { type: "done" }> | undefined;
  let status = 200;

  await send(chunk({ role: "assistant" }, null));

  try {
    let current: IteratorResult<StreamChunk> = first;
    while (!current.done) {
      const c = current.value;
      if (c.type === "delta") {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          deps.metrics.timeToFirstToken.observe({ provider: "router" }, (performance.now() - started) / 1000);
        }
        const safe = filter ? filter.push(c.content) : c.content;
        if (safe === null) {
          deps.metrics.guardrailBlocks.inc({ stage: "output", rule: "canary" });
          controller.abort(new Error("canary tripped"));
          await send(chunk({ content: LEAK_REFUSAL }, "content_filter"));
          status = 451;
          break;
        }
        if (safe) await send(chunk({ content: safe }, null));
      } else {
        done = c;
        model = c.model;
      }
      if (raw.destroyed) break;
      current = await iterator.next();
    }

    if (status === 200) {
      const tail = filter?.flush();
      if (tail) await send(chunk({ content: tail }, null));
      await send(chunk({}, done?.finishReason ?? "stop"));
      if (done) {
        await send({
          id, object: "chat.completion.chunk", created, model, choices: [],
          usage: { prompt_tokens: done.promptTokens, completion_tokens: done.completionTokens, total_tokens: done.promptTokens + done.completionTokens },
        });
      }
    }
  } catch (err) {
    status = controller.signal.aborted ? 499 : 502;
    if (!raw.destroyed) {
      await send({ error: { type: "upstream_error", message: "The provider failed mid-stream." } });
    }
    req.log.warn({ err: (err as Error).message }, "stream failed");
  } finally {
    await iterator.return?.();
    if (!raw.destroyed) raw.end("data: [DONE]\n\n");
    meter({
      model,
      provider: done?.provider ?? "unknown",
      promptTokens: done?.promptTokens ?? 0,
      completionTokens: done?.completionTokens ?? 0,
      status,
      cached: false,
    });
  }
}
