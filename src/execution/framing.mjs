import { decode, encode, ProtocolError, schema } from "./protocol.mjs";

/** Canonical protocol frame: unsigned big-endian u32 byte length, then payload. */
export function frame(message) {
  const body = encode(message);
  const bytes = Buffer.allocUnsafe(4 + body.length);
  bytes.writeUInt32BE(body.length);
  bytes.set(body, 4);
  return bytes;
}

/** Incremental bounded reader. Any malformed/truncated stream poisons it forever. */
export class FrameDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body;
  #bodyBytes = 0;
  #closed = false;

  push(bytes) {
    if (this.#closed) throw new ProtocolError("transport-failed");
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length > schema.maxFrameBytes + 4) throw new ProtocolError("invalid-frame");
      const messages = [];
      let at = 0;
      while (at < bytes.length) {
        if (!this.#body) {
          const count = Math.min(4 - this.#headerBytes, bytes.length - at);
          this.#header.set(bytes.subarray(at, at + count), this.#headerBytes);
          this.#headerBytes += count;
          at += count;
          if (this.#headerBytes !== 4) continue;
          const length = this.#header.readUInt32BE();
          if (length === 0 || length > schema.maxFrameBytes) throw new ProtocolError("invalid-frame");
          this.#body = Buffer.allocUnsafe(length);
        }
        const count = Math.min(this.#body.length - this.#bodyBytes, bytes.length - at);
        this.#body.set(bytes.subarray(at, at + count), this.#bodyBytes);
        this.#bodyBytes += count;
        at += count;
        if (this.#bodyBytes === this.#body.length) {
          messages.push(decode(this.#body));
          this.#headerBytes = this.#bodyBytes = 0;
          this.#body = undefined;
        }
      }
      return messages;
    } catch (error) {
      this.#closed = true;
      this.#body = undefined;
      throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame");
    }
  }

  end() {
    if (this.#closed || this.#headerBytes !== 0 || this.#body) {
      this.#closed = true;
      this.#body = undefined;
      throw new ProtocolError("transport-failed");
    }
    this.#closed = true;
  }
}
