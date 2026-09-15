export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** How long to stay open before letting one trial request through. */
  cooldownMs: number;
  now?: () => number;
}

/**
 * Stops sending traffic to a provider that is failing.
 *
 * closed     normal; count consecutive failures, trip to open at the threshold
 * open       reject immediately (no network call) until the cooldown passes
 * half_open  let exactly one trial request through; success closes, failure re-opens
 *
 * Without this, a dead provider costs every request a full timeout before fallback kicks in. With it,
 * after a few failures requests skip straight to the next provider in milliseconds.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = "half_open";
      this.trialInFlight = false;
    }
    return this.state;
  }

  /** Returns true if a request may be sent now. Call `onSuccess`/`onFailure` afterwards. */
  tryAcquire(): boolean {
    const state = this.getState();
    if (state === "closed") return true;
    if (state === "half_open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.trialInFlight = false;
  }

  onFailure(): void {
    if (this.state === "half_open") {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.trialInFlight = false;
  }
}
