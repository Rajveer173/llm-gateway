# llm-gateway

[![ci](https://github.com/Rajveer173/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Rajveer173/llm-gateway/actions/workflows/ci.yml)

An OpenAI-compatible gateway that sits in front of LLM providers. Clients keep using the OpenAI SDK and change
only the base URL; the gateway adds API-key auth, per-key rate limiting, response caching, SSE streaming,
multi-provider fallback with circuit breakers, prompt-injection and data-leak guardrails, usage metering and
Prometheus metrics.

**Live demo:** _link added after deployment_ — try a normal prompt, a cached prompt, a prompt injection, a
secret-leak attempt, and a 10-request burst against the rate limiter.

## Results

Measured with [`load/run.ts`](load/run.ts) (autocannon, 50 connections, 15 s per scenario) on a laptop
(Intel i7-1360P, 16 threads; gateway, Postgres and Redis all local). Raw output is in [`load/results/`](load/results).

**Gateway overhead** — upstream is a mock provider that answers in 0 ms, so this isolates the gateway's own cost:

| scenario | req/s | p50 | p90 | p99 | errors |
|---|---:|---:|---:|---:|---:|
| baseline `/healthz` (bare Fastify) | 7,375 | 6 ms | 8 ms | 14 ms | 0 |
| chat, full pipeline (auth → rate limit → guardrails → router → upstream → metering) | 2,057 | 22 ms | 33 ms | 45 ms | 0 |

**Cache** — same test with a mock provider that takes 300 ms, closer to a real LLM:

| scenario | req/s | p50 | p99 |
|---|---:|---:|---:|
| cache miss (calls provider) | 149 | 330 ms | 443 ms |
| cache hit (served from Redis) | 1,683 | 28 ms | 53 ms |

With a 0 ms upstream a cache hit is slightly *slower* than a miss (it adds a Redis round-trip), which is why the
cache is only worth having in front of slow, expensive providers.

**Rate limiter correctness under load** — a key limited to a burst of 100 plus 10 req/s, hit by 50 concurrent
connections for 15 s: **35,224 requests attempted, 252 admitted, 250 expected** (+0.8%, from refills during run
start-up). The limit holds because the token bucket is one atomic Lua script in Redis.

## Architecture

```
client ─► authenticate ─► rate limit ─► input guardrail ─► cache lookup ─┬─► hit: return
          SHA-256 key     Redis Lua     injection            tenant-scoped │
          + 10 s cache    token bucket  heuristics           temp 0 only   └─► router ─► circuit breaker ─► provider A
                                                                                   └─ fallback on 5xx/429/timeout ─► provider B
client ◄─ SSE (backpressure-aware) ◄─ streaming canary filter ◄────────────────────────────────────────────────┘
          └─► usage meter (batched INSERTs to Postgres) · Prometheus metrics
```

| Path | What |
|---|---|
| `src/auth/` | Key generation and hashing, bearer auth, short-lived lookup cache |
| `src/ratelimit/` | Token bucket as a Redis Lua script; per-key and per-IP limits |
| `src/cache/` | Exact-match, tenant-scoped response cache |
| `src/providers/` | Ollama and OpenAI-compatible (OpenAI, Gemini) adapters, mock, router, circuit breaker, stream parsing |
| `src/guardrails/` | Prompt-injection heuristics, canary detection, streaming canary filter |
| `src/metering/` | Batched, bounded, at-least-once usage writer |
| `src/routes/` | Chat completions (JSON + SSE), admin API |
| `src/observability/` | Prometheus metrics |
| `public/` | Demo playground |
| `load/` | Load test |

## Run it

```bash
docker compose up -d postgres redis   # or: npm run devdb (embedded Postgres, no Docker) + any Redis on :6380
cp .env.example .env
npm install
npx prisma db push
npm run dev                            # http://localhost:3000 serves the demo page
```

Or everything in containers: `docker compose up --build`.

Create a key and call it:

```bash
curl -X POST localhost:3000/admin/tenants/acme/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"rateCapacity": 20, "rateRefillPerSec": 1}'
# → {"key": "lgw_...", ...}   shown once

curl localhost:3000/v1/chat/completions -H "Authorization: Bearer lgw_..." -H "content-type: application/json" \
  -d '{"model": "fast", "messages": [{"role": "user", "content": "hello"}], "stream": true}'
```

Works with the official SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="lgw_...")
client.chat.completions.create(model="fast", messages=[{"role": "user", "content": "hi"}])
```

### Endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/v1/chat/completions` | API key |
| GET | `/v1/models` | API key |
| POST | `/admin/tenants/:tenant/keys` | admin token |
| POST | `/admin/keys/:id/revoke` | admin token |
| GET | `/admin/usage?tenant=&hours=` | admin token |
| GET | `/metrics` | optional `METRICS_TOKEN` |
| GET | `/healthz`, `/readyz` | none |
| POST | `/demo/chat` | none (per-IP limit, model allow-list, token cap) |

### Models and routing

`fast` is a portable alias: each provider maps it to its own small model (Ollama `qwen2.5:0.5b`, Gemini
`gemini-2.0-flash-lite`, OpenAI `gpt-4o-mini`), which is what makes cross-provider fallback possible. `gpt-*` and
`gemini-*` pass through to their vendor; other names go to Ollama. Override everything with `ROUTES_JSON`.

## Tests

```bash
npm test                   # unit + app tests (needs Redis on :6380)
INTEGRATION=1 npm test     # also runs the Postgres integration test
```

60 tests, including: exactly 10 of 50 concurrent requests admitted by a 10-token bucket over two Redis connections;
fallback before the first streamed token but never after; a canary split across stream chunks still caught;
cached answers not shared across tenants; failed usage batches retried in order.

## Design notes

These are the decisions worth being able to defend.

**Authentication**
- *SHA-256, not bcrypt, for API keys.* Slow hashes protect low-entropy passwords from brute force. A key with 256
  random bits can't be brute-forced, and a fast hash allows one indexed lookup per request.
- *Only the hash is stored.* A database leak doesn't leak usable keys; the plaintext is shown once.
- *Same 401 for missing, malformed, unknown and revoked keys*, so callers can't probe which keys exist.
- *10 s in-process lookup cache.* Saves a Postgres query per request. Cost: a revoked key keeps working on
  other instances for up to 10 s. Only hits are cached, so random keys can't fill memory.

**Rate limiting**
- *Token bucket* over fixed windows (2× bursts at window edges) or sliding logs (store every timestamp). Two
  numbers per key; `capacity` sets the burst, `refillPerSec` the sustained rate.
- *Lua script:* read-compute-write from the app races between instances. Redis runs a script atomically.
- *Redis `TIME`*, not the app clock, because gateway hosts' clocks drift.
- *Authenticate before limiting*, so unauthenticated floods can't drain a real key's bucket.
- *Fails open* if Redis is down: availability over strictness; providers still enforce their own limits.

**Streaming**
- *Headers wait for the first token.* Until then, a provider failure (and fallback) can still return a proper
  502. After headers are sent the status is locked at 200, so later errors go inside the stream.
- *No fallback after the first token*: splicing two providers' answers would produce nonsense.
- *Backpressure:* when `write()` returns false the gateway waits for `drain`, instead of buffering the whole
  answer in memory for a slow client.
- *Client disconnect aborts the upstream request*, so nobody pays for tokens no one reads.

**Fallback and circuit breakers**
- Only upstream faults (network, timeout, 5xx, 429) fall back. A 400 means the request is bad and would fail
  everywhere.
- Without a breaker, a dead provider costs every request a full timeout. With it, after 3 failures requests skip
  that provider immediately; after the cooldown one trial request probes whether it has recovered.

**Caching**
- Only temperature-0 requests: caching sampled requests would silently remove the randomness asked for.
- Keys include the tenant, or one tenant's cached answer (possibly containing their data) could be served to another.

**Guardrails**
- The injection filter is a small regex heuristic and is easy to evade by paraphrase, translation or encoding. It
  is there to be measured, not trusted — see [llm-redteam](https://github.com/Rajveer173/llm-redteam).
- The output canary filter is the stronger control: it checks what actually leaves the system. In streams it holds
  back `longest canary − 1` characters so a secret split across chunks is still caught.

**Metering**
- Batched async `INSERT`s keep Postgres out of the request path.
- At-least-once: failed batches are retried in order; a lost acknowledgement can duplicate rows.
- The buffer is bounded (oldest dropped, counted in a metric) so a long outage can't exhaust memory.
- A crash loses up to one flush interval — fine for analytics; billing would need a durable queue first.

## Limitations

- Cache is exact-match only (no semantic cache).
- Rate limiting counts requests, not tokens.
- Schema is applied with `prisma db push`; a team setup would use checked-in migrations.
- Load numbers are from one laptop with everything co-located, not a production environment.
