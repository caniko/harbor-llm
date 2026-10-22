// Disposable native qualification fixture, not a production launcher/custodian.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function artifact() {
  const binary = process.env.HARBOR_OPENCODE_BINARY;
  const sha256 = process.env.HARBOR_OPENCODE_SHA256;
  assert.ok(binary && isAbsolute(binary), "HARBOR_OPENCODE_BINARY must select an exact native artifact");
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/, "HARBOR_OPENCODE_SHA256 must bind the selected executable");
  assert.equal(await realpath(binary), binary, "select the real artifact path");
  const metadata = await stat(binary);
  assert.ok(metadata.isFile() && metadata.size <= 512 * 1024 * 1024);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(binary)) hash.update(bytes);
  assert.equal(hash.digest("hex"), sha256, "native artifact changed");
  return { binary, sha256 };
}

export async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("native fixture condition timed out");
}

export async function standalone(root, configuration) {
  const selected = await artifact();
  const password = randomBytes(32).toString("base64url");
  for (const name of ["home", "config", "data", "cache", "state", "runtime", "work"]) {
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  }
  const child = spawn(selected.binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: join(root, "work"), detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_FILEWATCHER_DISABLE: "1", OPENCODE_DISABLE_FFF: "1",
      OPENCODE_PASSWORD: password, OPENCODE_DB: join(root, "engine.db"),
    },
  });
  let failure, output = "", stdoutBytes = 0, stderrBytes = 0, exited = false;
  let url;
  const closed = new Promise(resolve => child.once("close", () => { exited = true; resolve(); }));
  function kill(signal) { try { process.kill(-child.pid, signal); } catch {} }
  function fail() { failure = true; kill("SIGKILL"); }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", bytes => { stderrBytes += bytes.length; if (stderrBytes > 1024 * 1024) fail(); });
  child.stdout.on("data", bytes => {
    stdoutBytes += bytes.length;
    if (stdoutBytes > 65536) { fail(); return; }
    output += bytes.toString("utf8");
    if (!url && output.includes("\n")) {
      try {
        const ready = new URL(JSON.parse(output.slice(0, output.indexOf("\n"))).url);
        assert.equal(ready.protocol, "http:"); assert.equal(ready.hostname, "127.0.0.1");
        assert.equal(ready.pathname, "/"); assert.equal(ready.username + ready.password + ready.search + ready.hash, "");
        url = ready.origin;
      } catch { fail(); }
    }
  });
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  async function request(path, method = "GET", body) {
    assert.ok(!failure && !exited, "native server lost");
    const target = new URL(path, url);
    assert.equal(target.origin, url, "native fixture requests must remain on the selected server");
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    assert.ok(encoded === undefined || Buffer.byteLength(encoded) <= 65536, "native request overflow");
    const response = await fetch(target, {
      method, redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization, "content-type": "application/json" },
      body: encoded,
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length; assert.ok(size <= 1024 * 1024, "native response overflow"); chunks.push(value);
      }
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    if (method === "PATCH") {
      assert.equal(response.status, 204, `native HTTP ${method} ${path} status ${response.status}`);
      assert.equal(size, 0, "native inbox update must have no response body");
      return;
    }
    assert.equal(response.status, 200, `native HTTP ${method} ${path} status ${response.status}`);
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function stop(signal = "SIGTERM") {
    if (exited) return;
    kill(signal);
    const escalation = setTimeout(() => kill("SIGKILL"), 250);
    const timeout = new AbortController();
    try { await Promise.race([closed, delay(3000, undefined, { signal: timeout.signal }).then(() => { throw new Error("native cleanup unverified"); })]); }
    finally { timeout.abort(); clearTimeout(escalation); child.stdin.destroy(); }
    // Test processes can launch their own process groups; this is not descendant-custody evidence.
  }
  try {
    await waitFor(() => {
      assert.ok(!failure && !exited, "native server failed before readiness");
      return url;
    }, 30000);
    let info;
    await waitFor(async () => {
      try { info = await request("/api/info"); return true; } catch { return false; }
    }, 30000);
    assert.equal(info.pid, child.pid);
    assert.equal(info.version, "2.0.22+047c74e");
    return { request, stop, url, authorization, pid: child.pid, version: info.version, selected };
  } catch (error) { await stop("SIGKILL"); throw error; }
}
