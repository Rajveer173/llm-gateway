export interface UsageRecord {
  apiKeyId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: number;
  cached: boolean;
  createdAt: Date;
}

export interface UsageSink {
  writeBatch(records: UsageRecord[]): Promise<void>;
}

export interface UsageMeterOptions {
  flushIntervalMs: number;
  maxBatchSize: number;
  /** Upper bound on buffered records if the database is down. Beyond it, the oldest are dropped. */
  maxBuffered: number;
  onError?: (err: unknown, batchSize: number) => void;
  onDrop?: (dropped: number) => void;
}

/**
 * Writes usage asynchronously in batches.
 *
 * Writing one row per request inside the request path adds a database round-trip to every call and
 * makes an LLM response wait on Postgres. Instead requests append to an in-memory buffer and a timer
 * flushes it with one multi-row INSERT.
 *
 * Trade-offs to be able to explain:
 * - A crash loses up to one flush interval of usage. Acceptable for analytics; for billing you would
 *   write to a durable queue (Redis Streams, Kafka) first.
 * - A failed batch is put back at the front of the buffer and retried: at-least-once. If the insert
 *   succeeded but the acknowledgement was lost, rows can duplicate.
 * - The buffer is bounded so a long database outage can't grow memory without limit.
 */
export class UsageMeter {
  private buffer: UsageRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly sink: UsageSink,
    private readonly opts: UsageMeterOptions,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    this.timer.unref();
  }

  record(entry: UsageRecord): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.opts.maxBuffered) {
      const dropped = this.buffer.length - this.opts.maxBuffered;
      this.buffer.splice(0, dropped);
      this.opts.onDrop?.(dropped);
    }
    if (this.buffer.length >= this.opts.maxBatchSize) void this.flush();
  }

  get pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    // Serialize flushes: wait for an in-flight flush, then send whatever is left. Returning the in-flight
    // promise instead would let a caller (like shutdown) believe records were written when they weren't.
    while (this.flushing) await this.flushing;
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.opts.maxBatchSize);
    this.flushing = this.sink
      .writeBatch(batch)
      .catch((err) => {
        this.buffer.unshift(...batch);
        this.opts.onError?.(err, batch.length);
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Drain what we can on shutdown; give up after a few failed attempts rather than hang forever.
    for (let i = 0; i < 5 && this.buffer.length > 0; i++) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break;
    }
  }
}
