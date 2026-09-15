import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from "./circuitBreaker.js";
import {
  type ChatRequest,
  type ChatResult,
  type Provider,
  type StreamChunk,
  UpstreamError,
} from "./types.js";

export interface Route {
  /** Models whose name starts with this prefix use this route. "" matches everything. */
  modelPrefix: string;
  /** Providers to try in order. */
  providers: string[];
  /** Optional per-provider model name override, e.g. map "fast" to "qwen2.5:0.5b" on ollama. */
  modelMap?: Record<string, string>;
}

export interface RouterEvents {
  onAttempt?(provider: string, outcome: "success" | "failure" | "skipped_open"): void;
}

export class NoProviderAvailableError extends UpstreamError {
  constructor(readonly attempts: { provider: string; reason: string }[]) {
    super(`all providers failed: ${attempts.map((a) => `${a.provider} (${a.reason})`).join(", ")}`, "router");
    this.name = "NoProviderAvailableError";
  }
}

/**
 * Picks providers for a model and falls back through them. Each provider has its own circuit breaker.
 *
 * Only UpstreamError triggers fallback. UpstreamClientError (a bad request) and client aborts propagate
 * immediately: trying the same bad request on another provider wastes money and hides the real error.
 */
export class ProviderRouter implements Provider {
  readonly name = "router";
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly providers: Map<string, Provider>,
    private readonly routes: Route[],
    breakerOptions: CircuitBreakerOptions,
    private readonly events: RouterEvents = {},
  ) {
    for (const name of providers.keys()) this.breakers.set(name, new CircuitBreaker(breakerOptions));
    for (const route of routes) {
      for (const p of route.providers) {
        if (!providers.has(p)) throw new Error(`route "${route.modelPrefix}" references unknown provider "${p}"`);
      }
    }
  }

  circuitStates(): Record<string, CircuitState> {
    return Object.fromEntries([...this.breakers].map(([name, b]) => [name, b.getState()]));
  }

  private plan(req: ChatRequest): { provider: Provider; breaker: CircuitBreaker; request: ChatRequest }[] {
    // Longest matching prefix wins, so "gpt-4o-mini" can have a different route than "gpt-".
    const route = [...this.routes]
      .filter((r) => req.model.startsWith(r.modelPrefix))
      .sort((a, b) => b.modelPrefix.length - a.modelPrefix.length)[0];
    if (!route) throw new NoProviderAvailableError([{ provider: "-", reason: `no route for model ${req.model}` }]);

    return route.providers.map((name) => ({
      provider: this.providers.get(name)!,
      breaker: this.breakers.get(name)!,
      request: { ...req, model: route.modelMap?.[name] ?? req.model },
    }));
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const attempts: { provider: string; reason: string }[] = [];
    for (const { provider, breaker, request } of this.plan(req)) {
      if (!breaker.tryAcquire()) {
        attempts.push({ provider: provider.name, reason: "circuit open" });
        this.events.onAttempt?.(provider.name, "skipped_open");
        continue;
      }
      try {
        const result = await provider.chat(request, signal);
        breaker.onSuccess();
        this.events.onAttempt?.(provider.name, "success");
        return result;
      } catch (err) {
        if (!(err instanceof UpstreamError)) {
          // Client-caused or aborted: the provider is healthy, so release a half-open trial as a success.
          breaker.onSuccess();
          throw err;
        }
        breaker.onFailure();
        this.events.onAttempt?.(provider.name, "failure");
        attempts.push({ provider: provider.name, reason: err.message });
      }
    }
    throw new NoProviderAvailableError(attempts);
  }

  /**
   * Streaming fallback is only possible before the first token. Once bytes have gone to the client we
   * can't restart the answer on another provider without the client seeing two different answers
   * spliced together, so a mid-stream failure is surfaced as a stream error instead.
   */
  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const attempts: { provider: string; reason: string }[] = [];
    for (const { provider, breaker, request } of this.plan(req)) {
      if (!breaker.tryAcquire()) {
        attempts.push({ provider: provider.name, reason: "circuit open" });
        this.events.onAttempt?.(provider.name, "skipped_open");
        continue;
      }
      let started = false;
      try {
        for await (const chunk of provider.chatStream(request, signal)) {
          if (!started) {
            started = true;
            breaker.onSuccess();
            this.events.onAttempt?.(provider.name, "success");
          }
          yield chunk;
        }
        if (!started) breaker.onSuccess();
        return;
      } catch (err) {
        if (!(err instanceof UpstreamError)) {
          if (!started) breaker.onSuccess();
          throw err;
        }
        breaker.onFailure();
        this.events.onAttempt?.(provider.name, "failure");
        if (started) throw err;
        attempts.push({ provider: provider.name, reason: err.message });
      }
    }
    throw new NoProviderAvailableError(attempts);
  }
}
