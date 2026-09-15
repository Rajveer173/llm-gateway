import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class Metrics {
  readonly registry = new Registry();

  readonly requestDuration = new Histogram({
    name: "gateway_request_duration_seconds",
    help: "End-to-end request duration as seen by the gateway",
    labelNames: ["route", "status", "stream", "cache"] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly timeToFirstToken = new Histogram({
    name: "gateway_time_to_first_token_seconds",
    help: "Time from request start to the first streamed token",
    labelNames: ["provider"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly providerAttempts = new Counter({
    name: "gateway_provider_attempts_total",
    help: "Upstream attempts by provider and outcome",
    labelNames: ["provider", "outcome"] as const,
    registers: [this.registry],
  });

  readonly circuitState = new Gauge({
    name: "gateway_circuit_open",
    help: "1 if the provider's circuit breaker is open or half-open",
    labelNames: ["provider"] as const,
    registers: [this.registry],
  });

  readonly cacheLookups = new Counter({
    name: "gateway_cache_lookups_total",
    help: "Response cache lookups",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: "gateway_rate_limited_total",
    help: "Requests rejected with 429",
    registers: [this.registry],
  });

  readonly guardrailBlocks = new Counter({
    name: "gateway_guardrail_blocks_total",
    help: "Requests or responses blocked by guardrails",
    labelNames: ["stage", "rule"] as const,
    registers: [this.registry],
  });

  readonly tokens = new Counter({
    name: "gateway_tokens_total",
    help: "Tokens processed",
    labelNames: ["provider", "direction"] as const,
    registers: [this.registry],
  });

  readonly usageDropped = new Counter({
    name: "gateway_usage_records_dropped_total",
    help: "Usage records dropped because the metering buffer overflowed",
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }
}
