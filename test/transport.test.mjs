import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runJson, TransportError } from "../src/transport.mjs";

const limits = { timeoutMs: 5000, inputBytes: 4096, outputBytes: 4096, stderrBytes: 1024 };
const command = (source, options = {}) => runJson(process.execPath, ["-e", source], { limits, ...options });

test("native JSON subprocess preserves argument boundaries and input", async () => {
  const value = await runJson(process.execPath, ["-e", "process.stdin.pipe(process.stdout)", "$(no-shell)"], {
    input: { text: "🧪", argument: "$(no-shell)" }, limits,
  });
  assert.deepEqual(value, { text: "🧪", argument: "$(no-shell)" });
});

test("transport returns only redacted typed failures", async () => {
  for (const source of [
    "process.stderr.write('synthetic-private-secret'); process.exit(2)",
    "process.stdout.write('synthetic-private-secret')",
  ]) {
    await assert.rejects(command(source), error => error instanceof TransportError
      && !String(error).includes("synthetic-private-secret") && error.cause === undefined);
  }
});

test("byte bounds reject multibyte output, input and stderr", async () => {
  await assert.rejects(command("process.stdout.write(JSON.stringify('🧪'.repeat(1024)))"), { code: "output-limit" });
  await assert.rejects(command("process.stderr.write('x'.repeat(1025)); process.stdout.write('{}')"), { code: "stderr-limit" });
  await assert.rejects(command("process.stdin.resume()", { input: "🧪".repeat(1024) }), { code: "input-limit" });
});

test("invalid budgets and already-cancelled calls spawn no child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-no-spawn-"));
  try {
    const marker = join(dir, "effect");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'effect')`;
    for (const invalid of [0, -1, NaN, Infinity, 1.5, 3600001]) {
      await assert.rejects(command(source, { limits: { ...limits, timeoutMs: invalid } }), { code: "invalid-options" });
    }
    await assert.rejects(command(source, { signal: AbortSignal.abort() }), { code: "cancelled" });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeout and cancellation settle only after direct child close", async () => {
  await assert.rejects(command("setInterval(() => {}, 1000)", { limits: { ...limits, timeoutMs: 30 } }), { code: "timeout" });
  const controller = new AbortController();
  const pending = command("process.stdout.write('{'); setInterval(() => {}, 1000)", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
});

test("trailing JSON, duplicate keys and invalid UTF-8 reject", async () => {
  for (const bytes of [Buffer.from('{}{}'), Buffer.from('{"a":1,"a":2}'), Buffer.from([0xff])]) {
    await assert.rejects(command(`process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`), { code: "invalid-json" });
  }
});

test("valid exit cannot turn an earlier overflow into success", async () => {
  await assert.rejects(command("process.on('SIGTERM', () => process.exit(0)); process.stdout.write(' '.repeat(8192) + '{}')"), { code: "output-limit" });
});

test("literal absolute executable, bounded argument list and explicit environment", async () => {
  await assert.rejects(runJson("node", ["-e", ""], { limits }), { code: "invalid-options" });
  assert.equal(await command("process.stdout.write(JSON.stringify(process.env.HARBOR_TEST_VALUE))", {
    env: { HARBOR_TEST_VALUE: "isolated" },
  }), "isolated");
});

test("bounded input serialization never invokes caller accessors or toJSON hooks", async () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { calls++; return "secret"; } });
  for (const input of [getter, { toJSON() { calls++; return {}; } }, new Array(10), { value: Infinity }]) {
    await assert.rejects(command("process.stdout.write('{}')", { input }), { code: "invalid-options" });
  }
  assert.equal(calls, 0);
});

test("missing executable is redacted and a deep output is rejected", async () => {
  await assert.rejects(runJson("/no-such-harbor-executable", [], { limits }), { code: "spawn-failed" });
  await assert.rejects(command("process.stdout.write('['.repeat(66) + '0' + ']'.repeat(66))"), { code: "invalid-json" });
});

test("losing a child reply never automatically resubmits an effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-one-effect-"));
  try {
    const marker = join(dir, "effect");
    await assert.rejects(command(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'effect\\n'); process.exit(1)`), { code: "exit-failed" });
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a child ignoring SIGTERM is escalated and reaped within the cleanup bound", async () => {
  const start = performance.now();
  await assert.rejects(command("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", {
    limits: { ...limits, timeoutMs: 500 },
  }), { code: "timeout" });
  assert.ok(performance.now() - start < 4000);
});

test("a surviving process group cannot be reported as successful cleanup", async () => {
  const source = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.once('message', () => { process.stdout.write('{}'); process.exit(0); });
  `;
  await assert.rejects(command(source), { code: "cleanup-unverified" });
});
