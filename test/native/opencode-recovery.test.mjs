import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { OpenCodeV2 } from "../../src/execution/opencode-v2.mjs";
import { artifact, standalone, waitFor } from "./standalone.mjs";

// An explicit native gate: absence of the selected artifact is a failure, never a skip.
// Counters and retained evidence are owned by this observer, outside engine roots.
for (const phase of ["provider", "tool", "steer-input", "competing-input"]) test(phase === "steer-input"
  ? "actual standalone rejects already-steering release without provider work"
  : `actual standalone reopens interrupted ${phase} state without replay`, { timeout: 90000 }, async t => {
  const selected = await artifact();
  const evidenceRoot = process.env.HARBOR_NATIVE_EVIDENCE_ROOT;
  assert.ok(evidenceRoot && isAbsolute(evidenceRoot), "HARBOR_NATIVE_EVIDENCE_ROOT must select private retained evidence");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(evidenceRoot, "recovery-"));
  t.diagnostic(`Retaining native ${phase} attempt: ${evidence}`);
  let completed = false;
  const root = join(evidence, "engine");
  const counter = join(evidence, "provider.jsonl");
  await writeFile(counter, "", { mode: 0o600 });
  let count = 0, toolCalls = 0, providerFailure;
  const requests = [];
  const provider = createServer((req, res) => {
    handle(req, res).catch(() => { providerFailure = true; res.destroy(); });
  });
  provider.requestTimeout = 5000;
  provider.headersTimeout = 5000;
  provider.maxConnections = 16;
  async function handle(req, res) {
    assert.equal(req.method, req.url === "/tool" ? "GET" : "POST");
    assert.ok(["/tool", "/v1/chat/completions"].includes(req.url), "unexpected synthetic endpoint");
    let size = 0;
    const chunks = [];
    for await (const bytes of req) {
      size += bytes.length;
      if (size > 1024 * 1024) { res.destroy(); return; }
      chunks.push(bytes);
    }
    if (req.url === "/tool") {
      toolCalls++;
      assert.ok(toolCalls <= 8, "synthetic tool request budget exhausted");
      appendFileSync(counter, `${JSON.stringify({ type: "tool", ordinal: toolCalls })}\n`, { flush: true });
      // The real shell tool remains interrupted in an independently observed call.
      res.writeHead(200, { "content-type": "text/plain" }); res.write("tool begun");
      return;
    }
    count++;
    assert.ok(count <= 8, "synthetic provider request budget exhausted");
    // Record receipt before acknowledging any synthetic provider work.
    appendFileSync(counter, `${JSON.stringify({ type: "provider", ordinal: count, method: req.method, path: req.url })}\n`, { flush: true });
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (phase === "tool" && request.tools?.some(tool => tool.function?.name === "shell")) {
      const code = `fetch("http://127.0.0.1:${provider.address().port}/tool", {signal: AbortSignal.timeout(15000)}).then(r => r.text()).catch(() => {})`;
      const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
      const command = `${quote(process.execPath)} -e ${quote(code)}`;
      const chunk = { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {
        role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: {
          name: "shell", arguments: JSON.stringify({ command, timeout: 20000 }),
        } }],
      }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "fixture begun" }, finish_reason: null }] })}\n\n`);
    // Hold the provider call open so termination leaves a real execution claim.
  }
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  t.after(async () => {
    if (!completed) await writeFile(join(evidence, "failure.json"), JSON.stringify({
      schemaVersion: 1, accepted: false, phase, artifact: selected, providerCalls: count, toolCalls,
    }), { mode: 0o600 });
  });
  const configuration = {
    update: "disable", share: "disabled", plugins: [], snapshots: false, warming: false,
    providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-only", timeout: 60000 },
      models: { fixture: { limit: { context: 8192, output: 1024 }, capabilities: { tools: true } } },
    } },
    agents: { title: { disabled: true }, build: { steps: 1, model: { providerID: "fixture", id: "fixture" } } },
  };
  let running = await standalone(root, configuration);
  t.after(async () => { await running.stop(); });
  const sessionID = `ses_${randomBytes(16).toString("hex")}`;
  const adapter = (mode = "observe") => new OpenCodeV2({
    url: running.url, authorization: running.authorization, server: { pid: running.pid, version: running.version },
    sessionID, directory: join(root, "work"), mode,
    limits: { timeoutMs: 15000, inputBytes: 65536, outputBytes: 1024 * 1024, totalResponseBytes: 16 * 1024 * 1024, requests: 64, pages: 8, messages: 128 },
  });
  const fresh = adapter("fresh");
  t.after(() => fresh.close());
  await fresh.probe();
  await fresh.start({
    model: { providerID: "fixture", id: "fixture" }, permissions: [
      { action: "*", resource: "*", effect: "deny" },
      ...(phase === "tool" ? [{ action: "shell", resource: "*", effect: "allow" }] : []),
    ],
  });
  const inboxID = `msg_${randomBytes(16).toString("hex")}`;
  const prompt = { id: inboxID, text: `Synthetic ${phase} recovery fixture.`, delivery: phase === "steer-input" ? "steer" : "queue", resume: false };
  const admitted = await fresh.submit(prompt);
  await delay(250);
  assert.equal(count, 0, "admit-only prompt must not manufacture an executing recovery fixture");
  if (phase === "steer-input") {
    await assert.rejects(fresh.execute(inboxID), { code: "effect-unknown" });
    await assert.rejects(fresh.execute(inboxID), { code: "effect-unknown" });
    const snapshot = await fresh.reconcile();
    assert.deepEqual(snapshot.inbox, [admitted]);
    assert.equal(snapshot.messages.length, 0);
    assert.equal(count + toolCalls, 0, "unsupported release must not create provider/tool work");
    assert.equal(providerFailure, undefined);
    await writeFile(join(evidence, "result.json"), JSON.stringify({
      schemaVersion: 1, accepted: false, scope: "native-standalone-release-precondition", phase,
      artifact: selected, sourceAttestation: "external-prerequisite", productionCustody: "unproven",
      configurationDigest: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
      sessionID, inboxID, releaseResult: "rejected", providerCalls: count, toolCalls,
    }, null, 2), { mode: 0o600 });
    completed = true;
    return;
  }
  let competingID;
  const competingText = "UNRELATED-INPUT-NEGATIVE-CONTROL";
  if (phase === "competing-input") {
    const observed = await running.request(`/api/session/${sessionID}/inbox`);
    assert.equal(observed.data.length, 1, "the preflight observes only the original input");
    competingID = `msg_${randomBytes(16).toString("hex")}`;
    await running.request(`/api/session/${sessionID}/prompt`, "POST", {
      id: competingID, text: competingText, delivery: "steer", resume: false,
    });
    assert.equal(count, 0, "the competing admission alone must not wake execution");
    // Deliberately unfenced control: an intervening writer invalidates the read.
    // This targets the original ID yet wakes both items. Never a production path.
    await running.request(`/api/session/${sessionID}/inbox/${inboxID}`, "PATCH", { delivery: "steer" });
  } else {
    // This isolated fixture is its only writer. Recovery never releases again.
    await fresh.execute(inboxID);
    await assert.rejects(fresh.execute(inboxID), { code: "effect-unknown" });
  }
  await waitFor(() => count >= 1);
  if (phase === "tool") await waitFor(() => toolCalls >= 1);
  const providerInput = JSON.stringify(requests[0].messages);
  assert.equal(providerInput.split(prompt.text).length - 1, 1, "the original input must reach the provider exactly once");
  assert.equal(providerInput.includes(competingText), phase === "competing-input", "a targeted PATCH is a whole-session wake, not a single-input fence");
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true });
  t.after(() => database.close());
  const claim = () => database.prepare("SELECT time_suspended, resume_attempts FROM session_v2 WHERE id = ?").get(sessionID);
  await waitFor(() => typeof claim()?.time_suspended === "number");
  const before = { ...claim() };
  assert.equal(typeof before.time_suspended, "number", "the fixture must persist a real execution claim");
  const providerCalls = count;
  const beforeToolCalls = toolCalls;
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, providerCalls + toolCalls);
  // Reattachment is independent from a server restart.
  let observer = adapter();
  await observer.probe(); await observer.reconcile(); observer.close();
  assert.equal(count, providerCalls);
  assert.equal(toolCalls, beforeToolCalls);
  await running.stop("SIGKILL");
  assert.deepEqual({ ...claim() }, before, "process death must leave the recovery marker intact");
  running = await standalone(root, configuration);
  observer = adapter();
  await observer.probe(); await observer.reconcile();
  const observationMs = 3000;
  await delay(observationMs);
  await observer.reconcile(); observer.close();
  assert.equal(count, providerCalls, "standalone reopen replayed provider work");
  assert.equal(toolCalls, beforeToolCalls, "standalone reopen replayed tool work");
  assert.deepEqual({ ...claim() }, before, "observational reopen must not consume or rewrite the execution claim");
  assert.equal(providerFailure, undefined, "independent provider observer failed");
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, count + toolCalls);
  await writeFile(join(evidence, "result.json"), JSON.stringify({
    schemaVersion: 1, accepted: false, scope: "native-standalone-feasibility", phase, artifact: selected, engineVersion: running.version,
    engineRevision: "047c74ec64ca6029f93be4bb4d1f5797c8838b9a", sourceAttestation: "external-prerequisite",
    configurationDigest: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
    sessionID, inboxID, ...(competingID ? { competingID } : {}), claim: before, providerCalls, callsAfterReopen: count, toolCalls, observationMs,
    releasePath: competingID ? "unfenced-session-wide-negative-control" : "fresh-adapter-inbox-steer",
    providerRecovery: "passed", toolRecovery: phase === "tool" ? "passed" : "unproven", productionCustody: "unproven",
  }, null, 2), { mode: 0o600 });
  completed = true;
  assert.ok(requests.length > 0, "positive control must reach the independently observed provider");
  t.diagnostic(`Retained native ${phase} evidence: ${evidence}`);
});
