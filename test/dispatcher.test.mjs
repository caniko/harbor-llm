import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { InitialDispatcher } from "../src/execution/dispatcher.mjs";
import { AuthenticatedChannel, schemaDigest, TransferReceiver } from "../src/execution/commands.mjs";

const binding = { callerAuthority: "controller", callerNamespace: "fixture", intentId: "job", executionId: "ses_fixture", executionGeneration: "1", inputDigest: "a".repeat(64), policyDigest: "b".repeat(64), implementationDigest: "c".repeat(64) };
const credentials = { key: Buffer.alloc(32, 1), nonce: Buffer.alloc(32, 2), binding: Buffer.alloc(32, 3) };
const configuration = { model: { providerID: "synthetic", id: "fixture" }, permissions: [] };
const input = { text: "exact original input" };
const limits = { timeoutMs: 5000, inputBytes: 65536, records: 64 };
async function fixture(t, { mode, interruptAuthority, lost = false, stalled = false, dispatcherLimits = limits } = {}) {
  const requests = [];
  let session, inbox = [];
  const http = createServer(async (req, res) => {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    const json = value => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/api/info") {
      if (stalled) return;
      return json({ version: "2.0.22", pid: 123 });
    }
    if (req.method === "POST" && req.url === "/api/session") { session = { ...body, model: { variant: "default", ...body.model } }; return json({ data: session }); }
    if (req.method === "POST" && req.url.endsWith("/prompt")) {
      const { id, delivery, resume, ...payload } = body;
      inbox = [{ id, delivery, payload, sessionID: binding.executionId, type: "user" }];
      return json({ data: inbox[0] });
    }
    if (req.method === "POST" && req.url.endsWith("/interrupt?resume=false")) return json({ interrupted: true });
    if (req.method === "PATCH") {
      if (lost) return res.destroy();
      res.writeHead(204); return res.end();
    }
    if (req.url.endsWith("/inbox")) return json({ data: inbox });
    if (req.url.includes("/message?")) return json({ data: [], cursor: {} });
    return json({ data: session });
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const dispatcher = new InitialDispatcher({ binding, credentials, mode, interruptAuthority, limits: dispatcherLimits,
    adapter: { url: `http://127.0.0.1:${http.address().port}`, authorization: "Basic fixture", server: { pid: 123, version: "2.0.22" }, directory: "/sealed",
      limits: { timeoutMs: 5000, inputBytes: 65536, outputBytes: 65536, totalResponseBytes: 1024 * 1024, requests: 64, pages: 4, messages: 8 } } });
  t.after(() => { dispatcher.close(); http.closeAllConnections(); http.close(); });
  const channel = new AuthenticatedChannel({ ...credentials, role: "controller" });
  let ordinal = 0;
  const observations = [];
  const send = async (body, changes) => {
    const request = { schemaVersion: 2, commandSchemaDigest: schemaDigest, requestId: `request-${++ordinal}`, binding, body, ...changes };
    let receiver;
    const response = await dispatcher.handle(channel.seal(request), async record => {
      const reply = channel.open(record);
      assert.equal(reply.requestId, request.requestId);
      assert.deepEqual(reply.binding, binding);
      if (reply.body.kind === "transfer-begin") receiver = new TransferReceiver(reply.body.reference, { maximumBytes: 65536, timeoutMs: 5000 });
      else if (reply.body.kind === "transfer-chunk") receiver.push(reply.body);
      else observations.push(JSON.parse(Buffer.from(receiver.finish(reply.body)).toString()));
    });
    return response ? channel.open(response) : undefined;
  };
  const transfer = async (purpose, value, transferId = purpose) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const reference = { purpose, transferId, bytes: String(bytes.length), digest: createHash("sha256").update(bytes).digest("hex") };
    await send({ kind: "transfer-begin", reference });
    await send({ kind: "transfer-chunk", transferId, offset: "0", data: bytes.toString("hex") });
    await send({ kind: "transfer-end", transferId });
    return reference;
  };
  return { dispatcher, channel, send, transfer, requests, observations };
}

test("authenticated initial dispatch uses only the original queued input and one release", async t => {
  const { send, transfer, requests } = await fixture(t, { mode: "fresh" });
  const config = await transfer("configuration", configuration);
  const created = await send({ kind: "create", configuration: config });
  assert.equal(created.body.operation, "create");
  const admitted = await transfer("input", input);
  assert.equal((await send({ kind: "submit", handle: binding.executionId, inboxId: "msg_original", input: admitted })).body.state, "observed");
  const execute = { kind: "execute", handle: binding.executionId, inboxId: "msg_original", inputDigest: admitted.digest };
  assert.equal((await send(execute)).body.operation, "execute");
  await assert.rejects(send(execute), { code: "effect-unknown" });
  assert.deepEqual(requests.filter(request => request.method === "PATCH").map(request => request.body), [{ delivery: "steer" }]);
  assert.equal(requests.filter(request => request.path.endsWith("/prompt")).length, 1);
  assert.deepEqual(requests.find(request => request.path.endsWith("/prompt")).body, { ...input, id: "msg_original", delivery: "queue", resume: false });
});

test("observation mode, changed binding and unsupported cancellation never contact the engine", async t => {
  const observe = await fixture(t);
  await assert.rejects(observe.transfer("configuration", configuration), { code: "authority-denied" });
  assert.equal(observe.requests.length, 0);
  const changed = await fixture(t, { mode: "fresh" });
  await assert.rejects(changed.send({ kind: "create", configuration: { transferId: "absent", purpose: "configuration", bytes: "1", digest: "d".repeat(64) } },
    { binding: { ...binding, executionGeneration: "2" } }), { code: "authority-denied" });
  assert.equal(changed.requests.length, 0);
  const cancel = await fixture(t, { mode: "fresh" });
  await assert.rejects(cancel.send({ kind: "interrupt", handle: binding.executionId, authorityDigest: "e".repeat(64) }), { code: "unsupported-capability" });
  assert.equal(cancel.requests.length, 0);
});

test("transfer purpose, aggregate bytes, records and deadlines fail before engine work", async t => {
  const purpose = await fixture(t, { mode: "fresh" });
  const reference = await purpose.transfer("input", input);
  await assert.rejects(purpose.send({ kind: "create", configuration: reference }), { code: "custody-lost" });
  assert.equal(purpose.requests.length, 0);
  const oversized = await fixture(t, { mode: "fresh", dispatcherLimits: { ...limits, inputBytes: 1 } });
  await assert.rejects(oversized.transfer("configuration", configuration), { code: "budget-exhausted" });
  assert.equal(oversized.requests.length, 0);
  const records = await fixture(t, { mode: "fresh", dispatcherLimits: { ...limits, records: 1 } });
  await assert.rejects(records.transfer("configuration", configuration), { code: "budget-exhausted" });
  assert.equal(records.requests.length, 0);
  const aggregate = await fixture(t, { mode: "fresh", dispatcherLimits: { ...limits, inputBytes: Buffer.byteLength(JSON.stringify(configuration)) + 1 } });
  await aggregate.send({ kind: "create", configuration: await aggregate.transfer("configuration", configuration) });
  await assert.rejects(aggregate.transfer("input", input), { code: "budget-exhausted" });
  assert.equal(aggregate.requests.filter(request => request.path.endsWith("/prompt")).length, 0);
  const expired = await fixture(t, { mode: "fresh", dispatcherLimits: { ...limits, timeoutMs: 1 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(expired.transfer("configuration", configuration), { code: "budget-exhausted" });
  assert.equal(expired.requests.length, 0);
});

test("the whole dispatcher deadline also aborts a stalled engine request", { timeout: 2000 }, async t => {
  const stalled = await fixture(t, { mode: "fresh", stalled: true, dispatcherLimits: { ...limits, timeoutMs: 50 } });
  const reference = await stalled.transfer("configuration", configuration);
  await assert.rejects(stalled.send({ kind: "create", configuration: reference }), { code: "transport-failed" });
  assert.ok(stalled.requests.every(request => request.method === "GET"));
});

test("lost HTTP release reply is terminal through the dispatcher and never reposts", async t => {
  const { send, transfer, requests } = await fixture(t, { mode: "fresh", lost: true });
  await send({ kind: "create", configuration: await transfer("configuration", configuration) });
  const admitted = await transfer("input", input);
  await send({ kind: "submit", handle: binding.executionId, inboxId: "msg_original", input: admitted });
  const execute = { kind: "execute", handle: binding.executionId, inboxId: "msg_original", inputDigest: admitted.digest };
  await assert.rejects(send(execute), { code: "effect-unknown" });
  await assert.rejects(send(execute), { code: "transport-failed" });
  assert.equal(requests.filter(request => request.method === "PATCH").length, 1);
  assert.equal(requests.filter(request => request.path.endsWith("/prompt")).length, 1);
});

test("bound reconciliation transfers complete observations and never releases work", async t => {
  const fresh = await fixture(t, { mode: "fresh" });
  await fresh.send({ kind: "create", configuration: await fresh.transfer("configuration", configuration) });
  const before = fresh.requests.filter(request => request.method !== "GET").length;
  const receipt = await fresh.send({ kind: "reconcile", handle: binding.executionId });
  assert.equal(receipt.body.kind, "output-receipt");
  assert.equal(fresh.observations.length, 1);
  assert.equal(fresh.observations[0].gap, true);
  assert.equal(fresh.observations[0].complete, false);
  assert.equal(fresh.requests.filter(request => request.method !== "GET").length, before);
  const observe = await fixture(t);
  // This observer has no session. A read is allowed; no create fallback is made.
  await assert.rejects(observe.send({ kind: "reopen", handle: binding.executionId }));
  assert.ok(observe.requests.every(request => request.method === "GET"));
});

test("interruption needs separately supplied current authority and stays one-shot", async t => {
  const denied = await fixture(t, { interruptAuthority: "e".repeat(64) });
  await assert.rejects(denied.send({ kind: "interrupt", handle: binding.executionId, authorityDigest: "f".repeat(64) }), { code: "authority-denied" });
  assert.equal(denied.requests.length, 0);
  const allowed = await fixture(t, { mode: "fresh", interruptAuthority: "e".repeat(64) });
  await allowed.send({ kind: "create", configuration: await allowed.transfer("configuration", configuration) });
  const cancel = { kind: "interrupt", handle: binding.executionId, authorityDigest: "e".repeat(64) };
  assert.equal((await allowed.send(cancel)).body.operation, "interrupt");
  await assert.rejects(allowed.send(cancel), { code: "effect-unknown" });
  assert.deepEqual(allowed.requests.filter(request => request.path.endsWith("/interrupt?resume=false")).map(request => request.body), [undefined]);
});
