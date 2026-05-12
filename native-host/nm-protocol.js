// Chrome Native Messaging wire protocol.
// Frame: [uint32 little-endian length][UTF-8 JSON body].
// Spec: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

"use strict";

const MAX_MESSAGE_SIZE = 1024 * 1024; // 1 MiB safety cap.

async function* readMessages(stream) {
  let buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_SIZE) {
        throw new Error(`Native message too large: ${length} bytes`);
      }
      if (buffer.length < 4 + length) break;

      const body = buffer.slice(4, 4 + length).toString("utf8");
      buffer = buffer.slice(4 + length);

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(`Invalid JSON from extension: ${err.message}`);
      }
      yield parsed;
    }
  }
}

function writeMessage(stream, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Outgoing message too large: ${body.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(header);
  stream.write(body);
}

module.exports = { readMessages, writeMessage, MAX_MESSAGE_SIZE };
