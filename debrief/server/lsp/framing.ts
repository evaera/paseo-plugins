/**
 * LSP's base protocol: `Content-Length: N\r\n\r\n` then N bytes of JSON.
 * Written by hand so the plugin carries no dependency for it.
 */
const SEPARATOR = Buffer.from("\r\n\r\n");

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Accumulates chunks from a server's stdout and yields whole messages. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feeds a chunk; returns every message it completed. Malformed bodies are skipped. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const end = this.buffer.indexOf(SEPARATOR);
      if (end === -1) break;
      const header = this.buffer.subarray(0, end).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (match === null) {
        // Not a header we understand: drop it and resynchronise on the next one.
        this.buffer = this.buffer.subarray(end + SEPARATOR.length);
        continue;
      }
      const length = Number(match[1]);
      const start = end + SEPARATOR.length;
      if (this.buffer.length < start + length) break;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        messages.push(JSON.parse(body) as unknown);
      } catch {
        // A server that wrote half a message is not worth crashing over.
      }
    }
    return messages;
  }
}
