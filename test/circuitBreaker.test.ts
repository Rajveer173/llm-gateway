import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/providers/circuitBreaker.js";

function breaker() {
  let now = 0;
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now });
  return { b, advance: (ms: number) => (now += ms) };
}

describe("CircuitBreaker", () => {
  it("opens after the threshold of consecutive failures", () => {
    const { b } = breaker();
    b.onFailure();
    b.onFailure();
    expect(b.getState()).toBe("closed");
    b.onFailure();
    expect(b.getState()).toBe("open");
    expect(b.tryAcquire()).toBe(false);
  });

  it("a success resets the consecutive-failure count", () => {
    const { b } = breaker();
    b.onFailure();
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    b.onFailure();
    expect(b.getState()).toBe("closed");
  });

  it("allows exactly one trial after the cooldown", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure();
    advance(1000);
    expect(b.getState()).toBe("half_open");
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it("closes when the trial succeeds and re-opens when it fails", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure();
    advance(1000);
    b.tryAcquire();
    b.onSuccess();
    expect(b.getState()).toBe("closed");

    for (let i = 0; i < 3; i++) b.onFailure();
    advance(1000);
    b.tryAcquire();
    b.onFailure();
    expect(b.getState()).toBe("open");
    advance(999);
    expect(b.tryAcquire()).toBe(false);
  });
});
