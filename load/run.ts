// Load test: measures the gateway's own overhead, not an LLM's.
//
// Start the gateway with MOCK_PROVIDER=true MOCK_LATENCY_MS=0 so the upstream answers instantly, then:
//   npx tsx load/run.ts
// Results are written to load/results/<timestamp>.json and printed as a markdown table.
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import autocannon from "autocannon";

const BASE = process.env.GATEWAY_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_TOKEN;
const DURATION = Number(process.env.DURATION ?? 20);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);
if (!ADMIN) throw new Error("set ADMIN_TOKEN");

async function createKey(capacity: number, refill: number) {
  const res = await fetch(`${BASE}/admin/tenants/loadtest/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "loadtest", rateCapacity: capacity, rateRefillPerSec: refill, guardrails: true }),
  });
  if (!res.ok) throw new Error(`key creation failed: ${res.status}`);
  return ((await res.json()) as { key: string }).key;
}

function run(title: string, opts: autocannon.Options): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon({ duration: DURATION, connections: CONNECTIONS, ...opts }, (err, result) =>
      err ? reject(err) : resolve(result),
    );
    process.stdout.write(`running: ${title}\n`);
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

const chat = (key: string, body: object): Partial<autocannon.Options> => ({
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const unlimited = await createKey(1_000_000_000, 1_000_000_000);

// Warm up connections, JIT, the auth cache and the Redis script cache.
await run("warmup", { url: `${BASE}/v1/chat/completions`, duration: 5, ...chat(unlimited, { model: "mock", messages: [{ role: "user", content: "warm" }] }) });

const scenarios: { name: string; what: string; result: autocannon.Result }[] = [];
// CACHE_ONLY=1 runs just the pipeline-vs-cache pair; use it with a slow mock upstream (MOCK_LATENCY_MS=300)
// to measure what the cache saves when the provider is slow, as real LLMs are.
const cacheOnly = process.env.CACHE_ONLY === "1";

if (!cacheOnly) scenarios.push({
  name: "baseline /healthz",
  what: "Fastify with no middleware: the floor",
  result: await run("healthz", { url: `${BASE}/healthz` }),
});

scenarios.push({
  name: "chat, full pipeline",
  what: "auth + Redis rate limit + guardrails + router + mock upstream + metering",
  result: await run("chat", { url: `${BASE}/v1/chat/completions`, ...chat(unlimited, { model: "mock", temperature: 0.7, messages: [{ role: "user", content: "Explain rate limiting briefly." }] }) }),
});

scenarios.push({
  name: "chat, cache hit",
  what: "same as above but temperature 0, served from Redis cache",
  result: await run("cache", { url: `${BASE}/v1/chat/completions`, ...chat(unlimited, { model: "mock", temperature: 0, messages: [{ role: "user", content: "Explain rate limiting briefly." }] }) }),
});

// Correctness under load: a 100-token bucket refilling 10/s, hammered for DURATION seconds.
// The limiter should admit about 100 + 10 * DURATION requests no matter how hard it is hit.
const limited = cacheOnly ? undefined : await createKey(100, 10);
const burst = limited
  ? await run("ratelimit", { url: `${BASE}/v1/chat/completions`, ...chat(limited, { model: "mock", messages: [{ role: "user", content: "hi" }] }) })
  : undefined;
const admitted = burst?.["2xx"] ?? 0;
const expected = 100 + 10 * DURATION;

const summary = {
  timestamp: new Date().toISOString(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: Math.round(totalmem() / 1e9) },
  settings: { durationSec: DURATION, connections: CONNECTIONS, upstream: `mock provider, ${process.env.MOCK_LATENCY_MS ?? 0} ms latency` },
  scenarios: scenarios.map((s) => ({
    name: s.name,
    what: s.what,
    requestsPerSec: Math.round(s.result.requests.average),
    p50ms: s.result.latency.p50,
    p90ms: s.result.latency.p90,
    p99ms: s.result.latency.p99,
    errors: s.result.errors + s.result.non2xx,
    total: s.result.requests.total,
  })),
  rateLimitCorrectness: burst
    ? {
        policy: "capacity 100, refill 10/s",
        attempted: burst.requests.total,
        admitted,
        rejected429: burst.non2xx,
        expectedAdmitted: expected,
        errorPct: Number((((admitted - expected) / expected) * 100).toFixed(2)),
      }
    : null,
};

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/${summary.timestamp.replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(summary, null, 2));

console.log(`\nmachine: ${summary.machine.cpu} (${summary.machine.cores} threads), ${DURATION}s per scenario, ${CONNECTIONS} connections\n`);
console.log("| scenario | req/s | p50 | p90 | p99 | errors |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const s of summary.scenarios) console.log(`| ${s.name} | ${s.requestsPerSec} | ${s.p50ms} ms | ${s.p90ms} ms | ${s.p99ms} ms | ${s.errors} |`);
const r = summary.rateLimitCorrectness;
if (r) console.log(`\nrate limiter under ${CONNECTIONS} connections: ${r.attempted} attempted, ${r.admitted} admitted, expected ${r.expectedAdmitted} (${r.errorPct}% off)`);
console.log(`saved ${file.pathname}`);
