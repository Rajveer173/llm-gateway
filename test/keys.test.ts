import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "../src/auth/keys.js";

describe("api keys", () => {
  it("generates keys in the expected format with a matching prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(looksLikeApiKey(key)).toBe(true);
    expect(key.startsWith(`${prefix}_`)).toBe(true);
  });

  it("never generates the same key twice", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });

  it("hashes deterministically and does not contain the key", () => {
    const { key } = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toContain(key);
  });

  it("rejects malformed keys before touching the database", () => {
    expect(looksLikeApiKey("sk-openai-style-key")).toBe(false);
    expect(looksLikeApiKey("lgw_short_secret")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });
});
