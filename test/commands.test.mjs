import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { AuthenticatedChannel, decode, encode, schema, schemaDigest, TransferReceiver } from "../src/execution/commands.mjs";
import { AuthenticatedChannel as ObservationChannel } from "../src/execution/channel.mjs";
import { decode as decodeV1 } from "../src/execution/protocol.mjs";

const binding = { callerAuthority: "controller", callerNamespace: "fixture", intentId: "job", executionId: "execution", executionGeneration: "1", inputDigest: "a".repeat(64), policyDigest: "b".repeat(64), implementationDigest: "c".repeat(64) };
const command = body => ({ schemaVersion: 2, commandSchemaDigest: schemaDigest, requestId: "request", binding, body });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const content = Buffer.from("retained prompt 🧪".repeat(3000));
const reference = { transferId: "input", bytes: String(content.length), digest: hash(content), purpose: "input" };
const limits = { maximumBytes: 128 * 1024, timeoutMs: 5000 };
const credentials = { key: Buffer.alloc(32, 1), nonce: Buffer.alloc(32, 2), binding: Buffer.alloc(32, 3) };
const peer = role => new AuthenticatedChannel({ ...credentials, role });

test("authenticated commands reject v1 records, reflection, tamper, replay and reordering terminally", () => {
  const value = command({ kind: "reopen", handle: "original" });
  const sender = peer("controller"), receiver = peer("bridge");
  const bytes = sender.seal(value);
  assert.deepEqual(receiver.open(bytes), value);
  assert.deepEqual(sender.open(receiver.seal(value)), value);
  assert.throws(() => receiver.open(bytes), { code: "authority-denied" });
  assert.throws(() => receiver.seal(value), { code: "transport-failed" });
  assert.throws(() => peer("controller").open(bytes), { code: "authority-denied" });
  for (let index = 0; index < bytes.length; index++) {
    const changed = Buffer.from(bytes); changed[index] ^= 1;
    const failed = peer("bridge");
    assert.throws(() => failed.open(changed));
    assert.throws(() => failed.open(bytes), { code: "transport-failed" });
  }
  assert.throws(() => peer("bridge").open(sender.seal(value)), { code: "authority-denied" });
  const old = new ObservationChannel({ ...credentials, role: "controller" });
  assert.throws(() => peer("bridge").open(old.seal({ schemaVersion: 1, requestId: "request", body: { kind: "error", code: "effect-unknown" } })), { code: "authority-denied" });
  assert.throws(() => new ObservationChannel({ ...credentials, role: "bridge" }).open(bytes), { code: "authority-denied" });
  const staleSchema = command({ kind: "reopen", handle: "original" });
  staleSchema.commandSchemaDigest = "a".repeat(64);
  const stale = peer("controller");
  assert.throws(() => stale.seal(staleSchema), { code: "custody-lost" });
  assert.throws(() => stale.seal(value), { code: "transport-failed" });
});

test("commands preserve exact binding and cannot decode as v1 observations", () => {
  for (const body of [
    { kind: "reopen", handle: "original" },
    { kind: "reconcile", handle: "original" },
    { kind: "create", configuration: { ...reference, purpose: "configuration" } },
    { kind: "submit", handle: "original", inboxId: "msg_original", input: reference },
    { kind: "execute", handle: "original", inboxId: "msg_original", inputDigest: reference.digest },
    ...["interrupt", "revoke", "close"].map(kind => ({ kind, handle: "original", authorityDigest: "e".repeat(64) })),
  ]) {
    const value = command(body);
    assert.deepEqual(decode(encode(value)), value);
    assert.throws(() => decodeV1(encode(value)), { code: "incompatible-version" });
  }
  assert.equal(schema.maxChunks, 4096);
  assert.ok(Object.isFrozen(schema.definitions));
});

test("bounded transfer spans frames and returns only complete content-bound bytes", () => {
  const receiver = new TransferReceiver(reference, limits);
  for (let offset = 0; offset < content.length; offset += 16384) {
    const body = { kind: "transfer-chunk", transferId: "input", offset: String(offset), data: content.subarray(offset, offset + 16384).toString("hex") };
    assert.ok(encode(command(body)).length <= 65536);
    receiver.push(decode(encode(command(body))).body);
  }
  assert.deepEqual(receiver.finish({ transferId: "input" }), content);
  assert.throws(() => receiver.finish({ transferId: "input" }), { code: "transport-failed" });
});

test("truncation, digest drift, reorder, identity, oversize and replay close transfers", () => {
  const chunk = { transferId: "input", offset: "0", data: content.subarray(0, 100).toString("hex") };
  for (const changed of [{ ...chunk, offset: "1" }, { ...chunk, transferId: "other" }, { ...chunk, data: "AA" }, { ...chunk, data: "aa".repeat(16385) }, { ...chunk, data: "" }]) {
    const receiver = new TransferReceiver(reference, limits);
    assert.throws(() => receiver.push(changed));
    assert.throws(() => receiver.push(chunk), { code: "transport-failed" });
  }
  const truncated = new TransferReceiver(reference, limits);
  truncated.push(chunk);
  assert.throws(() => truncated.finish({ transferId: "input" }));
  assert.throws(() => truncated.push(chunk));
  const replayed = new TransferReceiver(reference, limits);
  replayed.push(chunk);
  assert.throws(() => replayed.push(chunk));
  const wrongDigest = new TransferReceiver({ ...reference, bytes: "1", digest: "a".repeat(64) }, limits);
  wrongDigest.push({ transferId: "input", offset: "0", data: "ff" });
  assert.throws(() => wrongDigest.finish({ transferId: "input" }), { code: "custody-lost" });
  assert.throws(() => new TransferReceiver(reference, { ...limits, maximumBytes: 1 }));
  assert.throws(() => new TransferReceiver({ ...reference, purpose: "output", bytes: "16777217" }, { ...limits, maximumBytes: 67108864 }));
});

test("transfer deadlines, total length and chunk count are bounded including empty content", async () => {
  const empty = new TransferReceiver({ ...reference, bytes: "0", digest: hash("") }, limits);
  assert.deepEqual(empty.finish({ transferId: "input" }), Buffer.alloc(0));
  const overflow = new TransferReceiver({ ...reference, bytes: "1" }, limits);
  assert.throws(() => overflow.push({ transferId: "input", offset: "0", data: "aaaa" }), { code: "budget-exhausted" });
  const many = new TransferReceiver(reference, limits);
  for (let offset = 0; offset < schema.maxChunks; offset++) many.push({ transferId: "input", offset: String(offset), data: "aa" });
  assert.throws(() => many.push({ transferId: "input", offset: String(schema.maxChunks), data: "aa" }), { code: "budget-exhausted" });
  const expired = new TransferReceiver(reference, { ...limits, timeoutMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.throws(() => expired.push({ transferId: "input", offset: "0", data: "aa" }), { code: "budget-exhausted" });
  assert.throws(() => expired.finish({ transferId: "input" }), { code: "transport-failed" });
});

test("schema identity, unknown fields, chunk encoding and noncanonical bytes reject", () => {
  for (const value of [
    { ...command({ kind: "reopen", handle: "original" }), commandSchemaDigest: "f".repeat(64) },
    command({ kind: "execute", handle: "original", inboxId: "msg_original", inputDigest: reference.digest, resume: true }),
    ...["aa".repeat(16385), "f", "AA", ""].map(data => command({ kind: "transfer-chunk", transferId: "input", offset: "0", data })),
    command({ kind: "transfer-chunk", transferId: "input", offset: "01", data: "aa" }),
  ]) assert.throws(() => encode(value));
  const bytes = encode(command({ kind: "reopen", handle: "original" }));
  assert.throws(() => decode(Buffer.concat([bytes, Buffer.from(" ")])));
  let calls = 0;
  const value = command({ kind: "reopen", handle: "original" });
  Object.defineProperty(value, "requestId", { get() { calls++; return "replacement"; } });
  assert.throws(() => encode(value));
  assert.equal(calls, 0);
});
