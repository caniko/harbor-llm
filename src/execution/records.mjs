/** Internal byte-record authentication, shared by the separately bound codecs. */
import { createHmac, timingSafeEqual } from "node:crypto";
import contract from "../../protocol/channel.json" with { type: "json" };
import { ProtocolError, schema } from "./protocol.mjs";

export class AuthenticatedRecords {
  #sendKey;
  #receiveKey;
  #sent = 0n;
  #received = 0n;
  constructor({ key, nonce, binding, role }, { domain, schemaDigest }) {
    if (!(key instanceof Uint8Array) || key.length !== contract.keyBytes
        || !(nonce instanceof Uint8Array) || nonce.length !== contract.channelBytes
        || !(binding instanceof Uint8Array) || binding.length !== contract.bindingBytes
        || !contract.roles.includes(role)) throw new ProtocolError("authority-denied");
    const derive = direction => createHmac("sha256", key).update(domain).update(Buffer.from([0]))
      .update(Buffer.from(schemaDigest, "hex")).update(nonce).update(binding).update(direction).digest();
    this.#sendKey = derive(role);
    this.#receiveKey = derive(role === "controller" ? "bridge" : "controller");
  }
  ready() { if (!this.#sendKey) throw new ProtocolError("transport-failed"); }
  seal(payload) {
    this.ready();
    try {
      if (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > schema.maxFrameBytes) throw new ProtocolError("invalid-frame");
      if (this.#sent === 18446744073709551615n) throw new ProtocolError("authority-denied");
      const record = Buffer.alloc(12 + payload.length + contract.tagBytes);
      record.writeBigUInt64BE(++this.#sent);
      record.writeUInt32BE(payload.length, 8);
      record.set(payload, 12);
      const tag = createHmac("sha256", this.#sendKey).update(record.subarray(0, -contract.tagBytes)).digest();
      record.set(tag, record.length - contract.tagBytes);
      return record;
    } catch (error) { this.close(); throw error; }
  }
  open(bytes) {
    this.ready();
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length < 45 || bytes.length > schema.maxFrameBytes + 44) throw new ProtocolError("invalid-frame");
      const record = Buffer.from(bytes);
      const length = record.readUInt32BE(8);
      if (length === 0 || length > schema.maxFrameBytes || record.length !== 44 + length) throw new ProtocolError("invalid-frame");
      const expected = createHmac("sha256", this.#receiveKey).update(record.subarray(0, -32)).digest();
      if (!timingSafeEqual(expected, record.subarray(-32)) || record.readBigUInt64BE() !== this.#received + 1n
          || this.#received === 18446744073709551615n) throw new ProtocolError("authority-denied");
      this.#received++;
      return record.subarray(12, -32);
    } catch (error) {
      this.close();
      throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame");
    }
  }
  close() {
    this.#sendKey?.fill(0); this.#receiveKey?.fill(0);
    this.#sendKey = this.#receiveKey = undefined;
  }
}
