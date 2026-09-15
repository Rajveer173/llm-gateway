import { type ChatRequest, type ChatResult, type Provider, type StreamChunk, UpstreamError } from "./types.js";

/**
 * Deterministic in-process provider with configurable latency. Used for load tests (so we measure the
 * gateway's own overhead, not an LLM's), for tests, and as a zero-cost fallback in the public demo.
 */
export class MockProvider implements Provider {
  failNext = 0;

  constructor(
    readonly name = "mock",
    private readonly latencyMs = 0,
    private readonly tokensPerAnswer = 20,
  ) {}

  private answer(req: ChatRequest): string {
    const last = req.messages.at(-1)?.content ?? "";
    const words = [`[${this.name}]`, "you", "said:", ...last.split(/\s+/).slice(0, 12)];
    while (words.length < this.tokensPerAnswer) words.push("lorem");
    return words.slice(0, Math.max(this.tokensPerAnswer, words.length)).join(" ");
  }

  private async wait(ms: number, signal?: AbortSignal) {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    });
  }

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new UpstreamError(`${this.name} simulated outage`, this.name, 503);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    await this.wait(this.latencyMs, signal);
    this.maybeFail();
    const content = this.answer(req);
    return {
      content,
      model: req.model,
      provider: this.name,
      promptTokens: req.messages.reduce((n, m) => n + m.content.split(/\s+/).length, 0),
      completionTokens: content.split(" ").length,
      finishReason: "stop",
    };
  }

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    this.maybeFail();
    const words = this.answer(req).split(" ");
    const perToken = this.latencyMs / words.length;
    for (const [i, word] of words.entries()) {
      await this.wait(perToken, signal);
      yield { type: "delta", content: i === 0 ? word : ` ${word}` };
    }
    yield {
      type: "done",
      model: req.model,
      provider: this.name,
      promptTokens: req.messages.reduce((n, m) => n + m.content.split(/\s+/).length, 0),
      completionTokens: words.length,
      finishReason: "stop",
    };
  }
}
