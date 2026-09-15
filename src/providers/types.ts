export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: "stop" | "length";
}

export type StreamChunk =
  | { type: "delta"; content: string }
  | {
      type: "done";
      model: string;
      provider: string;
      promptTokens: number;
      completionTokens: number;
      finishReason: "stop" | "length";
    };

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  chatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}

/**
 * An upstream failed in a way the client did not cause: network error, timeout, 5xx or 429.
 * Only these trigger fallback to the next provider. A 400 from upstream means the request itself is
 * bad, and retrying it elsewhere would just fail again.
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Upstream rejected the request itself (4xx other than 429). Not retried. */
export class UpstreamClientError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamClientError";
  }
}

export function classifyHttpFailure(provider: string, status: number, body: string): Error {
  const message = `${provider} returned ${status}: ${body.slice(0, 200)}`;
  if (status >= 500 || status === 429 || status === 408) return new UpstreamError(message, provider, status);
  return new UpstreamClientError(message, provider, status);
}
