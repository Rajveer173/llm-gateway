import { readSseData } from "./lines.js";
import {
  type ChatRequest,
  type ChatResult,
  type Provider,
  type StreamChunk,
  UpstreamError,
  classifyHttpFailure,
} from "./types.js";

interface CompletionResponse {
  model: string;
  choices: { message?: { content: string | null }; delta?: { content?: string | null }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

/**
 * Any provider that speaks the OpenAI Chat Completions API: OpenAI itself, and Google Gemini through its
 * OpenAI-compatible endpoint (https://generativelanguage.googleapis.com/v1beta/openai). One adapter, many
 * providers — the same reason this gateway exposes that API to its own clients.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 120_000,
  ) {}

  private async post(req: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream,
          ...(stream && { stream_options: { include_usage: true } }),
        }),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`${this.name} unreachable: ${(err as Error).message}`, this.name);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyHttpFailure(this.name, res.status, body);
    }
    return res;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await this.post(req, false, signal);
    const data = (await res.json()) as CompletionResponse;
    const choice = data.choices[0];
    return {
      content: choice?.message?.content ?? "",
      model: data.model,
      provider: this.name,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason === "length" ? "length" : "stop",
    };
  }

  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const res = await this.post(req, true, signal);
    if (!res.body) throw new UpstreamError(`${this.name} returned no body`, this.name);

    let model = req.model;
    let finishReason: "stop" | "length" = "stop";
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const data of readSseData(res.body)) {
      const event = JSON.parse(data) as CompletionResponse;
      model = event.model ?? model;
      const choice = event.choices[0];
      if (choice?.delta?.content) yield { type: "delta", content: choice.delta.content };
      if (choice?.finish_reason === "length") finishReason = "length";
      // With include_usage, usage arrives in a final chunk that has no choices.
      if (event.usage) {
        promptTokens = event.usage.prompt_tokens;
        completionTokens = event.usage.completion_tokens;
      }
    }
    yield { type: "done", model, provider: this.name, promptTokens, completionTokens, finishReason };
  }
}
