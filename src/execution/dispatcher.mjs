import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AuthenticatedChannel, decode, encode, schema, schemaDigest, TransferReceiver } from "./commands.mjs";
import { ProtocolError } from "./protocol.mjs";
import { OpenCodeV2 } from "./opencode-v2.mjs";
import { encodeJson, parseJson } from "../json.mjs";
import ceilings from "../../protocol/transport.json" with { type: "json" };

const reject = code => { throw new ProtocolError(code); };
function bound(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) reject("budget-exhausted");
  return value;
}

/** Initial-command endpoint, not a launcher or custodian. Trusted launch supplies
 * original binding, fresh channel credentials and exclusive standalone custody.
 * Only the original Rust admission holder may select fresh mode and must fsync
 * its reservation before sending each effect. Reopening never reconstructs it.
 */
export class InitialDispatcher {
  #binding;
  #channel;
  #adapter;
  #fresh;
  #deadline;
  #limits;
  #records = 0;
  #bytes = 0;
  #transfers = 0;
  #transfer;
  #input;
  #interruptAuthority;
  #interruptUsed = false;
  #busy = false;
  #closed = false;
  constructor({ binding, credentials, adapter, mode = "observe", limits, interruptAuthority }) {
    try {
      if (!["fresh", "observe"].includes(mode)) reject("invalid-frame");
      this.#binding = decode(encode({ schemaVersion: 2, commandSchemaDigest: schemaDigest, requestId: "initial-binding", binding,
        body: { kind: "reopen", handle: binding.executionId } })).binding;
      this.#limits = { timeoutMs: bound(limits.timeoutMs, ceilings.maxTimeoutMs), inputBytes: bound(limits.inputBytes, ceilings.maxInputBytes),
        // ponytail: two artifacts (configuration/input) for one initial turn;
        // a future multi-turn protocol must explicitly expand this transaction.
        records: bound(limits.records, 2 * (schema.maxChunks + 2) + 3) };
      this.#fresh = mode === "fresh";
      if (interruptAuthority !== undefined && !/^[a-f0-9]{64}$/.test(interruptAuthority)) reject("invalid-frame");
      this.#interruptAuthority = interruptAuthority;
      this.#deadline = performance.now() + this.#limits.timeoutMs;
      this.#channel = new AuthenticatedChannel({ ...credentials, role: "bridge" });
      const deadline = AbortSignal.timeout(this.#limits.timeoutMs);
      this.#adapter = new OpenCodeV2({ ...adapter, mode, sessionID: this.#binding.executionId,
        signal: adapter.signal ? AbortSignal.any([deadline, adapter.signal]) : deadline });
    } catch (error) { this.close(); throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame"); }
  }

  #take(reference, purpose) {
    if (!this.#transfer?.bytes || reference.purpose !== purpose || !isDeepStrictEqual(reference, this.#transfer.reference)) reject("custody-lost");
    const bytes = this.#transfer.bytes;
    this.#transfer = undefined;
    return parseJson(bytes);
  }
  #remaining() {
    const remaining = Math.floor(this.#deadline - performance.now());
    if (remaining < 1) reject("budget-exhausted");
    return remaining;
  }
  #seal(command) {
    this.#remaining();
    if (++this.#records > this.#limits.records) reject("budget-exhausted");
    return this.#channel.seal(command);
  }

  /** Accept one complete authenticated record. Transfers produce no response;
   * effects return one authenticated receipt. Every failure terminally closes
   * this endpoint. Disposal aborts local I/O, never claims descendant cleanup.
   */
  async handle(record, sendTransfer) {
    try {
      if (this.#closed || this.#busy) reject("transport-failed");
      this.#remaining();
      if (++this.#records > this.#limits.records) reject("budget-exhausted");
      this.#busy = true;
      const command = this.#channel.open(record);
      if (!isDeepStrictEqual(command.binding, this.#binding)) reject("authority-denied");
      const body = command.body;
      if ("handle" in body && body.handle !== this.#binding.executionId) reject("authority-denied");
      if (["reopen", "reconcile"].includes(body.kind)) {
        if (typeof sendTransfer !== "function") reject("unsupported-capability");
        await this.#adapter.probe();
        const bytes = encodeJson(await this.#adapter.reconcile(), ceilings.maxOutputBytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const transferId = "observation";
        const send = async body => sendTransfer(this.#seal({ ...command, body }));
        await send({ kind: "transfer-begin", reference: { purpose: "observation", transferId, digest, bytes: String(bytes.length) } });
        for (let offset = 0; offset < bytes.length; offset += schema.maxChunkBytes) {
          await send({ kind: "transfer-chunk", transferId, offset: String(offset), data: Buffer.from(bytes.subarray(offset, offset + schema.maxChunkBytes)).toString("hex") });
        }
        await send({ kind: "transfer-end", transferId });
        return this.#seal({ ...command, body: { kind: "output-receipt", binding: this.#binding, outputDigest: digest, outputBytes: String(bytes.length) } });
      }
      if (body.kind === "interrupt") {
        if (this.#interruptAuthority === undefined) reject("unsupported-capability");
        if (body.authorityDigest !== this.#interruptAuthority) reject("authority-denied");
        if (this.#interruptUsed) reject("effect-unknown");
        // Consume even if the probe or reply is lost. The controller must already
        // have fsynced its separately authorized original-execution interrupt.
        this.#interruptUsed = true;
        await this.#adapter.probe();
        const result = await this.#adapter.interrupt();
        return this.#seal({ ...command, body: { kind: "receipt", operation: "interrupt", state: "observed",
          receiptDigest: createHash("sha256").update(encodeJson(result, ceilings.maxOutputBytes)).digest("hex") } });
      }
      if (!["create", "submit", "execute", "transfer-begin", "transfer-chunk", "transfer-end"].includes(body.kind)) reject("unsupported-capability");
      if (!this.#fresh) reject("authority-denied");
      if (body.kind === "transfer-begin") {
        if (this.#transfer || ++this.#transfers > 2) reject("budget-exhausted");
        this.#bytes += Number(body.reference.bytes);
        if (!Number.isSafeInteger(this.#bytes) || this.#bytes > this.#limits.inputBytes) reject("budget-exhausted");
        this.#transfer = { reference: body.reference, receiver: new TransferReceiver(body.reference,
          { maximumBytes: Math.min(this.#limits.inputBytes, body.reference.purpose === "input" ? schema.maxInputBytes : schema.maxOutputBytes),
            timeoutMs: this.#remaining() }) };
        return;
      }
      if (body.kind === "transfer-chunk") {
        if (!this.#transfer?.receiver) reject("invalid-frame");
        this.#transfer.receiver.push(body); return;
      }
      if (body.kind === "transfer-end") {
        if (!this.#transfer?.receiver) reject("invalid-frame");
        this.#transfer.bytes = this.#transfer.receiver.finish(body);
        this.#transfer.receiver = undefined; return;
      }
      let result;
      if (body.kind === "create") {
        const configuration = this.#take(body.configuration, "configuration");
        this.#remaining();
        await this.#adapter.probe();
        result = await this.#adapter.start(configuration);
      } else if (body.kind === "submit") {
        const input = this.#take(body.input, "input");
        if (input === null || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some(key => !["text", "files", "agents", "skills", "metadata"].includes(key))) reject("invalid-frame");
        this.#remaining();
        result = await this.#adapter.submit({ ...input, id: body.inboxId, delivery: "queue", resume: false });
        this.#input = { inboxId: body.inboxId, digest: body.input.digest };
      } else {
        if (!this.#input || body.inboxId !== this.#input.inboxId || body.inputDigest !== this.#input.digest) reject("custody-lost");
        this.#remaining();
        result = await this.#adapter.execute(body.inboxId);
      }
      const receiptDigest = createHash("sha256").update(encodeJson(result ?? null, ceilings.maxOutputBytes)).digest("hex");
      return this.#seal({ ...command, body: { kind: "receipt", operation: body.kind, state: "observed", receiptDigest } });
    } catch (error) {
      this.close();
      throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame");
    } finally { this.#busy = false; }
  }
  /** Terminal local disposal; does not revoke credentials or stop the server. */
  close() {
    this.#closed = true;
    this.#channel?.close(); this.#adapter?.close(); this.#transfer?.receiver?.close();
    this.#transfer = this.#input = this.#interruptAuthority = undefined;
  }
}
