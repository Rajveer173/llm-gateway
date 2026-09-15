import type { ChatMessage } from "../providers/types.js";

export interface GuardrailConfig {
  /**
   * Secret strings that must never appear in a response: planted canaries, internal hostnames, key
   * prefixes. If one shows up in model output, the model has been tricked into leaking context.
   */
  canaries: string[];
  /** Block requests whose user content matches known prompt-injection phrasing. */
  blockInjectionPatterns: boolean;
}

export interface InputVerdict {
  blocked: boolean;
  rule?: string;
}

// Deliberately a small, readable heuristic list, not a claim of robust detection. Phrase lists are easy
// to evade (paraphrase, translation, encoding); llm-redteam measures exactly how easy. The output
// canary filter is the stronger control, because it checks what actually leaves the system.
const INJECTION_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "ignore_instructions", pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|rules|prompt|directions)\b/i },
  { rule: "reveal_system_prompt", pattern: /\b(reveal|print|show|repeat|output|leak|tell me)\b[^.\n]{0,40}\b(system|hidden|initial|original)\s+(prompt|instructions?|message)\b/i },
  { rule: "role_override", pattern: /\byou are (now )?(dan|in developer mode|no longer bound|unrestricted|jailbroken)\b/i },
  { rule: "fake_system_turn", pattern: /(^|\n)\s*(###\s*)?(system|assistant)\s*:\s/i },
  { rule: "instruction_delimiter_escape", pattern: /<\/?(system|instructions?)>|\[\/?INST\]/i },
];

export function checkInput(messages: ChatMessage[], config: GuardrailConfig): InputVerdict {
  if (!config.blockInjectionPatterns) return { blocked: false };
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const { rule, pattern } of INJECTION_RULES) {
      if (pattern.test(message.content)) return { blocked: true, rule };
    }
  }
  return { blocked: false };
}

export function findCanary(text: string, canaries: string[]): string | undefined {
  const lower = text.toLowerCase();
  return canaries.find((c) => c.length > 0 && lower.includes(c.toLowerCase()));
}

export const LEAK_REFUSAL = "I can't share that.";

/**
 * Canary filter for streamed output.
 *
 * The hard part: a canary can be split across chunks ("CANARY-" in one delta, "7f3a" in the next), so
 * checking each chunk alone misses it. We hold back the last (longestCanary - 1) characters, which is
 * the longest possible partial match, and only release text that can no longer be the start of a canary.
 * The cost is a few characters of extra latency at the end of the stream.
 */
export class StreamingCanaryFilter {
  private held = "";
  private readonly holdBack: number;
  tripped: string | undefined;

  constructor(private readonly canaries: string[]) {
    this.holdBack = Math.max(0, ...canaries.map((c) => c.length - 1));
  }

  /** Returns the text that is safe to emit now, or null if a canary was found (stop the stream). */
  push(delta: string): string | null {
    if (this.tripped) return null;
    this.held += delta;
    const hit = findCanary(this.held, this.canaries);
    if (hit) {
      this.tripped = hit;
      return null;
    }
    if (this.held.length <= this.holdBack) return "";
    const safe = this.held.slice(0, this.held.length - this.holdBack);
    this.held = this.held.slice(this.held.length - this.holdBack);
    return safe;
  }

  /** Call at end of stream to release the held-back tail. */
  flush(): string | null {
    if (this.tripped) return null;
    const rest = this.held;
    this.held = "";
    return rest;
  }
}
