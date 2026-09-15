import { readLines } from "./lines.js";
import {
  type ChatRequest,
  type ChatResult,
  type Provider,
  type StreamChunk,
  UpstreamError,
  classifyHttpFailure,
} from "./types.js";

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 120_000,
  ) {}

  private async post(req: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream,
          options: {
            ...(req.temperature !== undefined && { temperature: req.temperature }),
            ...(req.maxTokens !== undefined && { num_predict: req.maxTokens }),
          },
        }),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`ollama unreachable: ${(err as Error).message}`, this.name);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Ollama answers 404 for a model that isn't pulled; that is the client's mistake, not an outage.
      throw classifyHttpFailure(this.name, res.status, body);
    }
    return res;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await this.post(req, false, signal);
    const data = (await res.json()) as OllamaChatResponse;
    return {
      content: data.message?.content ?? "",
      model: data.model,
      provider: this.name,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      finishReason: data.done_reason === "length" ? "length" : "stop",
    };
  }

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const res = await this.post(req, true, signal);
    if (!res.body) throw new UpstreamError("ollama returned no body", this.name);

    // Ollama streams newline-delimited JSON, one object per token batch.
    for await (const line of readLines(res.body)) {
      if (!line.trim()) continue;
      const data = JSON.parse(line) as OllamaChatResponse;
      if (data.error) throw new UpstreamError(`ollama stream error: ${data.error}`, this.name);
      if (data.message?.content) yield { type: "delta", content: data.message.content };
      if (data.done) {
        yield {
          type: "done",
          model: data.model,
          provider: this.name,
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          finishReason: data.done_reason === "length" ? "length" : "stop",
        };
        return;
      }
    }
    throw new UpstreamError("ollama stream ended without a done message", this.name);
  }
}
