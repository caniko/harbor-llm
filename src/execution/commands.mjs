/** Versioned command data only. Decoding never dispatches or grants authority. */
import { schema, schemaDigest } from "./command-schema.mjs";
import { decodeWithSchema, encodeWithSchema, validateDefinition, ProtocolError } from "./protocol.mjs";
import { encodeJson, parseJson } from "../json.mjs";
import { createHash } from "node:crypto";
import ceilings from "../../protocol/transport.json" with { type: "json" };
import { AuthenticatedRecords } from "./records.mjs";
export { schema, schemaDigest };

const reject = code => { throw new ProtocolError(code); };
function identity(value) {
  if (value.commandSchemaDigest !== schemaDigest) reject("custody-lost");
  return value;
}
export function encode(value) {
  try {
    const snapshot = parseJson(encodeJson(value, schema.maxFrameBytes));
    return encodeWithSchema(identity(snapshot), schema);
  } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame"); }
}
export function decode(bytes) { return identity(decodeWithSchema(bytes, schema)); }

/** Command-specific authenticated records. Domain and schema identity are fixed;
 * caller-supplied metadata cannot turn a v1 observation channel into dispatch.
 */
export class AuthenticatedChannel {
  #records;
  constructor(options) { this.#records = new AuthenticatedRecords(options, { domain: schema.channelDomain, schemaDigest }); }
  seal(command) {
    try { this.#records.ready(); return this.#records.seal(encode(command)); }
    catch (error) { this.close(); throw error; }
  }
  open(bytes) {
    try { return decode(this.#records.open(bytes)); }
    catch (error) { this.close(); throw error; }
  }
  close() { this.#records.close(); }
}

function record(value, type, kind) {
  try {
    const snapshot = parseJson(encodeJson(value, schema.maxFrameBytes));
    if (kind && Object.hasOwn(snapshot, "kind")) {
      if (snapshot.kind !== kind) reject("invalid-frame");
      delete snapshot.kind;
    }
    validateDefinition(snapshot, type, schema);
    return snapshot;
  } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame"); }
}

/** One single-use transfer. The dispatcher must also bound total transfers and
 * channel lifetime and authenticate every frame. No partial content escapes.
 */
export class TransferReceiver {
  #reference;
  #chunks = [];
  #size = 0;
  #hash = createHash("sha256");
  #deadline;
  #active = true;
  constructor(reference, { maximumBytes, timeoutMs }) {
    this.#reference = record(reference, "TransferReference");
    const ceiling = this.#reference.purpose === "input" ? schema.maxInputBytes : schema.maxOutputBytes;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > ceiling
        || BigInt(this.#reference.bytes) > BigInt(maximumBytes)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ceilings.maxTimeoutMs) reject("budget-exhausted");
    this.#deadline = performance.now() + timeoutMs;
  }
  #ready() {
    if (!this.#active) reject("transport-failed");
    if (performance.now() >= this.#deadline) reject("budget-exhausted");
  }
  push(value) {
    try {
      this.#ready();
      const chunk = record(value, "TransferChunk", "transfer-chunk");
      if (chunk.transferId !== this.#reference.transferId || chunk.offset !== String(this.#size)) reject("invalid-frame");
      const bytes = Buffer.from(chunk.data, "hex");
      if (this.#chunks.length >= schema.maxChunks || BigInt(this.#size + bytes.length) > BigInt(this.#reference.bytes)) reject("budget-exhausted");
      this.#size += bytes.length;
      this.#hash.update(bytes);
      this.#chunks.push(bytes);
    } catch (error) { this.close(); throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame"); }
  }
  finish(value) {
    try {
      this.#ready();
      const end = record(value, "TransferEnd", "transfer-end");
      if (end.transferId !== this.#reference.transferId || String(this.#size) !== this.#reference.bytes) reject("invalid-frame");
      if (this.#hash.digest("hex") !== this.#reference.digest) reject("custody-lost");
      return Buffer.concat(this.#chunks, this.#size);
    } finally { this.close(); }
  }
  close() { this.#active = false; this.#chunks = []; this.#hash = undefined; }
}
