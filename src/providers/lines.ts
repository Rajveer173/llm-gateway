/**
 * Splits a byte stream into lines. Network chunks do not respect line boundaries: one chunk can hold
 * half a JSON object, or three of them. So we buffer until we see a newline, and decode with
 * `stream: true` so a multi-byte UTF-8 character (Hindi text, emoji) split across chunks isn't corrupted.
 */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/** Yields the `data:` payloads of a Server-Sent Events stream, stopping at `[DONE]`. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    if (data) yield data;
  }
}
