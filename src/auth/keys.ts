import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "lgw";

/**
 * Generates a new API key: `lgw_<8-char id>_<43-char secret>`.
 * The secret is 32 random bytes, so the key has 256 bits of entropy.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const id = randomBytes(6).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const key = `${KEY_PREFIX}_${id}_${secret}`;
  return { key, prefix: `${KEY_PREFIX}_${id}` };
}

/**
 * SHA-256, not bcrypt/argon2. Slow hashes exist to stop brute-forcing *low-entropy* secrets like
 * passwords. A 256-bit random key cannot be brute-forced, so a fast hash is safe, and it lets us
 * look the key up by an indexed column on every request instead of doing 100ms of work per call.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeApiKey(value: string): boolean {
  return /^lgw_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/.test(value);
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
