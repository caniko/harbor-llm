import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import ceilings from "../protocol/transport.json" with { type: "json" };
import { encodeJson, parseJson } from "./json.mjs";

Object.freeze(ceilings);

/** Stable redacted diagnostic; child output and native errors never enter it. */
export class TransportError extends Error {
  constructor(code) {
    super(`Harbor transport failed: ${code}`);
    this.name = "TransportError";
    this.code = code;
  }
}

function budget(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TransportError("invalid-options");
  return value;
}

/** Execute one bounded JSON operation. Never retries or interprets application success.
 * The caller supplies an approved absolute executable, environment and authority.
 * This helper is a transport, not a sandbox or an executable-custody verifier.
 */
export async function runJson(binary, args, options = {}) {
  let input, body, env, cwd, signal, limits;
  try {
    ({ input, cwd, signal } = options);
    env = { ...(options.env ?? {}) };
    const requested = { ...options.limits };
    limits = {
      timeoutMs: budget(requested.timeoutMs, ceilings.maxTimeoutMs),
      inputBytes: budget(requested.inputBytes, ceilings.maxInputBytes),
      outputBytes: budget(requested.outputBytes, ceilings.maxOutputBytes),
      stderrBytes: budget(requested.stderrBytes, ceilings.maxStderrBytes),
    };
    if (!Array.isArray(args) || process.platform === "win32") throw new Error();
    args = [...args];
    if (typeof binary !== "string" || !isAbsolute(binary) || binary.includes("\0")
        || args.length > ceilings.maxArguments || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
        || args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > ceilings.maxArgumentBytes
        || (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd)))
        || (signal !== undefined && !(signal instanceof AbortSignal))
        || Object.entries(env).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"))) throw new Error();
    body = input === undefined ? undefined : encodeJson(input, limits.inputBytes);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    if (error instanceof RangeError && error.message === "input-limit") throw new TransportError("input-limit");
    throw new TransportError("invalid-options");
  }
  if (body && body.length > limits.inputBytes) throw new TransportError("input-limit");
  if (signal?.aborted) throw new TransportError("cancelled");
  return new Promise((resolve, reject) => {
    let child, failure, timer, escalation, cleanup;
    const output = [];
    let outputBytes = 0, stderrBytes = 0;
    function kill(signal) {
      try {
        if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch { /* ESRCH and close races cannot clear a sticky failure. */ }
    }
    function fail(code) {
      if (failure || finished) return;
      failure = new TransportError(code);
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), ceilings.terminationGraceMs);
      cleanup = setTimeout(() => {
        child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
        finish(new TransportError("cleanup-unverified"));
      }, ceilings.cleanupTimeoutMs);
    }
    let finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanup);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    }
    const abort = () => fail("cancelled");
    try {
      child = spawn(binary, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch { finish(new TransportError("spawn-failed")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => fail("timeout"), limits.timeoutMs);
    child.on("error", () => { fail("spawn-failed"); });
    child.stdin.on("error", () => fail("input-failed"));
    child.stdout.on("error", () => fail("output-failed"));
    child.stderr.on("error", () => fail("output-failed"));
    child.stdout.on("data", bytes => {
      if (failure) return;
      outputBytes += bytes.length;
      if (outputBytes > limits.outputBytes) { fail("output-limit"); return; }
      output.push(bytes);
    });
    child.stderr.on("data", bytes => {
      stderrBytes += bytes.length;
      if (stderrBytes > limits.stderrBytes) fail("stderr-limit");
    });
    child.on("close", code => {
      // A surviving process in this private group prevents a cleanup/success claim.
      let descendants = false;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, 0); descendants = true; }
        catch (error) { descendants = error.code !== "ESRCH"; }
      }
      if (descendants) { kill("SIGKILL"); finish(new TransportError("cleanup-unverified")); return; }
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new TransportError("exit-failed")); return; }
      try { finish(undefined, parseJson(Buffer.concat(output, outputBytes))); }
      catch { finish(new TransportError("invalid-json")); }
    });
    child.stdin.end(body);
  });
}
