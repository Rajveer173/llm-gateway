-- Token bucket, evaluated atomically inside Redis.
--
-- KEYS[1]  bucket key (a hash with fields `tokens` and `ts`)
-- ARGV[1]  capacity         max tokens the bucket holds (the allowed burst)
-- ARGV[2]  refill_per_sec   tokens added per second (the sustained rate)
-- ARGV[3]  cost             tokens this request consumes
--
-- Returns { allowed (1/0), remaining tokens (floored), retry_after_ms }
--
-- Why a Lua script: "read tokens, compute, write tokens" is three steps. Done from the app with
-- separate GET/SET calls, two gateway instances can both read 1 token and both let a request
-- through. Redis runs a script to completion before serving any other command, so the whole
-- read-compute-write is one atomic step across every gateway instance.
--
-- Why Redis TIME instead of a timestamp passed from the app: gateway hosts' clocks drift. Using
-- the Redis server clock gives every instance the same notion of "now".

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  -- First request for this key: start full.
  tokens = capacity
  ts = now_ms
end

-- Refill for the time elapsed since the last update, never above capacity.
local elapsed_ms = math.max(0, now_ms - ts)
tokens = math.min(capacity, tokens + (elapsed_ms / 1000) * refill_per_sec)

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after_ms = math.ceil(((cost - tokens) / refill_per_sec) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)
-- Expire once the bucket would be full again: an idle key then costs no memory, and a missing
-- key is exactly equivalent to a full bucket.
local ms_to_full = math.ceil(((capacity - tokens) / refill_per_sec) * 1000)
redis.call('PEXPIRE', key, math.max(ms_to_full, 1000))

return { allowed, math.floor(tokens), retry_after_ms }
