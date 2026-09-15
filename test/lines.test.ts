import { describe, expect, it } from "vitest";
import { readLines, readSseData } from "../src/providers/lines.js";

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(gen: AsyncGenerator<string>) {
  const out: string[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("stream line parsing", () => {
  it("reassembles lines split across network chunks", async () => {
    const lines = await collect(readLines(streamOf([enc('{"a":'), enc('1}\n{"b"'), enc(":2}\n{\"c\":3}")])));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("does not corrupt a multi-byte character split between chunks", async () => {
    const bytes = enc("नमस्ते\n");
    const lines = await collect(readLines(streamOf([bytes.slice(0, 4), bytes.slice(4)])));
    expect(lines).toEqual(["नमस्ते"]);
  });

  it("extracts SSE data payloads and stops at [DONE]", async () => {
    const body = "event: x\ndata: {\"n\":1}\r\n\r\n: comment\ndata: {\"n\":2}\n\ndata: [DONE]\n\ndata: {\"n\":3}\n\n";
    expect(await collect(readSseData(streamOf([enc(body)])))).toEqual(['{"n":1}', '{"n":2}']);
  });
});
