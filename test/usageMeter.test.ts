import { describe, expect, it } from "vitest";
import { type UsageRecord, UsageMeter, type UsageSink } from "../src/metering/usageMeter.js";

const rec = (i: number): UsageRecord => ({
  apiKeyId: "k", model: "m", provider: "p", promptTokens: i, completionTokens: 1,
  latencyMs: 1, status: 200, cached: false, createdAt: new Date(),
});

class MemorySink implements UsageSink {
  batches: UsageRecord[][] = [];
  failTimes = 0;
  async writeBatch(records: UsageRecord[]) {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("db down");
    }
    this.batches.push(records);
  }
}

const opts = { flushIntervalMs: 60_000, maxBatchSize: 3, maxBuffered: 10 };

describe("UsageMeter", () => {
  it("flushes in batches of at most maxBatchSize", async () => {
    const sink = new MemorySink();
    const meter = new UsageMeter(sink, opts);
    for (let i = 0; i < 7; i++) meter.record(rec(i));
    await meter.stop();
    expect(sink.batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(sink.batches.flat().map((r) => r.promptTokens)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("retries a failed batch without losing or reordering records", async () => {
    const sink = new MemorySink();
    sink.failTimes = 1;
    let errors = 0;
    const meter = new UsageMeter(sink, { ...opts, maxBatchSize: 100, onError: () => errors++ });
    meter.record(rec(1));
    meter.record(rec(2));
    await meter.flush();
    expect(errors).toBe(1);
    expect(meter.pending).toBe(2);
    await meter.flush();
    expect(sink.batches.flat().map((r) => r.promptTokens)).toEqual([1, 2]);
  });

  it("bounds the buffer during an outage and drops the oldest", async () => {
    const sink = new MemorySink();
    sink.failTimes = Infinity;
    let dropped = 0;
    const meter = new UsageMeter(sink, { ...opts, maxBatchSize: 1000, onDrop: (n) => (dropped += n), onError: () => {} });
    for (let i = 0; i < 25; i++) meter.record(rec(i));
    expect(meter.pending).toBe(10);
    expect(dropped).toBe(15);
  });
});
