import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import { NoProviderAvailableError, ProviderRouter } from "../src/providers/router.js";
import { type ChatRequest, type Provider, type StreamChunk, UpstreamClientError, UpstreamError } from "../src/providers/types.js";

const req: ChatRequest = { model: "fast", messages: [{ role: "user", content: "hello there" }] };

class CountingProvider extends MockProvider {
  calls = 0;
  lastModel = "";
  override async chat(r: ChatRequest, s?: AbortSignal) {
    this.calls++;
    this.lastModel = r.model;
    return super.chat(r, s);
  }
}

function setup() {
  const primary = new CountingProvider("primary");
  const secondary = new CountingProvider("secondary");
  const router = new ProviderRouter(
    new Map<string, Provider>([["primary", primary], ["secondary", secondary]]),
    [
      { modelPrefix: "fast", providers: ["primary", "secondary"], modelMap: { primary: "p-small", secondary: "s-small" } },
      { modelPrefix: "fast-premium", providers: ["secondary"] },
    ],
    { failureThreshold: 2, cooldownMs: 60_000 },
  );
  return { primary, secondary, router };
}

describe("ProviderRouter", () => {
  it("uses the first provider and maps the model alias", async () => {
    const { primary, secondary, router } = setup();
    const res = await router.chat(req);
    expect(res.provider).toBe("primary");
    expect(primary.lastModel).toBe("p-small");
    expect(secondary.calls).toBe(0);
  });

  it("prefers the longest matching model prefix", async () => {
    const { primary, router } = setup();
    const res = await router.chat({ ...req, model: "fast-premium" });
    expect(res.provider).toBe("secondary");
    expect(primary.calls).toBe(0);
  });

  it("falls back on upstream failure", async () => {
    const { primary, router } = setup();
    primary.failNext = 1;
    const res = await router.chat(req);
    expect(res.provider).toBe("secondary");
  });

  it("stops calling a provider once its circuit opens", async () => {
    const { primary, router } = setup();
    primary.failNext = 100;
    await router.chat(req);
    await router.chat(req);
    expect(router.circuitStates().primary).toBe("open");
    const before = primary.calls;
    const res = await router.chat(req);
    expect(res.provider).toBe("secondary");
    expect(primary.calls).toBe(before);
  });

  it("does not fall back when the request itself is bad", async () => {
    const bad: Provider = {
      name: "bad",
      chat: async () => { throw new UpstreamClientError("400 bad model", "bad", 400); },
      chatStream: async function* () { throw new UpstreamClientError("400", "bad", 400); },
    };
    const secondary = new CountingProvider("secondary");
    const router = new ProviderRouter(new Map([["bad", bad], ["secondary", secondary]]), [{ modelPrefix: "", providers: ["bad", "secondary"] }], { failureThreshold: 1, cooldownMs: 1000 });
    await expect(router.chat(req)).rejects.toBeInstanceOf(UpstreamClientError);
    expect(secondary.calls).toBe(0);
    expect(router.circuitStates().bad).toBe("closed");
  });

  it("reports every attempt when all providers fail", async () => {
    const { primary, secondary, router } = setup();
    primary.failNext = 1;
    secondary.failNext = 1;
    const err = await router.chat(req).catch((e) => e);
    expect(err).toBeInstanceOf(NoProviderAvailableError);
    expect(err.attempts.map((a: { provider: string }) => a.provider)).toEqual(["primary", "secondary"]);
  });

  it("falls back for streams that fail before the first token", async () => {
    const { primary, router } = setup();
    primary.failNext = 1;
    const chunks: StreamChunk[] = [];
    for await (const c of router.chatStream(req)) chunks.push(c);
    const done = chunks.at(-1);
    expect(done?.type === "done" && done.provider).toBe("secondary");
  });

  it("does not splice providers after a stream has started", async () => {
    const flaky: Provider = {
      name: "flaky",
      chat: async () => { throw new Error("unused"); },
      chatStream: async function* () {
        yield { type: "delta", content: "partial" };
        throw new UpstreamError("connection reset", "flaky", 502);
      },
    };
    const secondary = new CountingProvider("secondary");
    const router = new ProviderRouter(new Map([["flaky", flaky], ["secondary", secondary]]), [{ modelPrefix: "", providers: ["flaky", "secondary"] }], { failureThreshold: 5, cooldownMs: 1000 });

    const seen: StreamChunk[] = [];
    await expect(async () => {
      for await (const c of router.chatStream(req)) seen.push(c);
    }).rejects.toBeInstanceOf(UpstreamError);
    expect(seen).toEqual([{ type: "delta", content: "partial" }]);
  });

  it("rejects routes that reference unknown providers at startup", () => {
    expect(() => new ProviderRouter(new Map(), [{ modelPrefix: "", providers: ["ghost"] }], { failureThreshold: 1, cooldownMs: 1 })).toThrow(/unknown provider/);
  });
});
