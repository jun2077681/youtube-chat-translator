// Chrome Native Messaging wire protocol.
// Frame: [uint32 little-endian length][UTF-8 JSON body].
// Spec: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import type { Readable, Writable } from "node:stream";

export const MAX_MESSAGE_SIZE = 1024 * 1024;

export async function* readMessages(stream: Readable): AsyncGenerator<unknown, void, void> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_SIZE) {
        throw new Error(`Native message too large: ${length} bytes`);
      }
      if (buffer.length < 4 + length) break;

      const body = buffer.slice(4, 4 + length).toString("utf8");
      buffer = buffer.slice(4 + length);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(`Invalid JSON from extension: ${(err as Error).message}`);
      }
      yield parsed;
    }
  }
}

export function writeMessage(stream: Writable, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Outgoing message too large: ${body.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(header);
  stream.write(body);
}
