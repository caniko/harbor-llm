import { OpenCode } from "@opencode/client";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import contract from "../../protocol/opencode-v2.json" with { type: "json" };
import ceilings from "../../protocol/transport.json" with { type: "json" };
import { encodeJson, parseJson } from "../json.mjs";
import { ProtocolError } from "./protocol.mjs";

Object.freeze(contract);

const reject = code => { throw new ProtocolError(code); };
function bound(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) reject("budget-exhausted");
  return value;
}
function id(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Exact-client transport seam, not a launcher, admission holder or sandbox.
 * Connect only to a custodian-owned private standalone server. Construction and
 * reopening have no network/process/provider effect; never uses Service.ensure.
 * The original Rust controller must fsync each effect intent before invoking its
 * matching method. Local one-shot guards supplement, never replace, that fence.
 * Fresh mode requires exclusive whole-session writer custody throughout admission
 * and release. Mode selection and inbox observations do not establish that custody.
 */
export class OpenCodeV2 {
  #client;
  #url;
  #server;
  #sessionID;
  #directory;
  #limits;
  #abort = new AbortController();
  #signal;
  #deadline;
  #requests = 0;
  #bytes = 0;
  #sentBytes = 0;
  #transportError;
  #ready = false;
  #busy = false;
  #closed = false;
  #started = false;
  #submitted = false;
  #interrupted = false;
  #created = false;
  #fresh;
  #admitted;
  #executed = false;

  constructor({ url, authorization, server, sessionID, directory, limits, signal, mode = "observe" }) {
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
          || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
          || !id(sessionID) || !isAbsolute(directory) || directory.includes("\0")
          || typeof authorization !== "string" || !/^(Basic|Bearer) [\x21-\x7e]{1,8192}$/.test(authorization)
          || !Number.isSafeInteger(server.pid) || server.pid < 1 || !id(server.version)
          || (signal !== undefined && !(signal instanceof AbortSignal))
          || !["fresh", "observe"].includes(mode)) reject("invalid-frame");
      this.#url = endpoint.origin;
      this.#server = { pid: server.pid, version: server.version };
      this.#sessionID = sessionID; this.#directory = directory;
      this.#fresh = mode === "fresh";
      this.#limits = {
        timeoutMs: bound(limits.timeoutMs, ceilings.maxTimeoutMs),
        inputBytes: bound(limits.inputBytes, ceilings.maxInputBytes),
        outputBytes: bound(limits.outputBytes, ceilings.maxOutputBytes),
        totalResponseBytes: bound(limits.totalResponseBytes, contract.maxTotalResponseBytes),
        requests: bound(limits.requests, contract.maxRequests),
        pages: bound(limits.pages, contract.maxPages),
        messages: bound(limits.messages, contract.maxMessages),
      };
      this.#signal = signal ? AbortSignal.any([this.#abort.signal, signal]) : this.#abort.signal;
      this.#deadline = performance.now() + this.#limits.timeoutMs;
      this.#client = OpenCode.make({ baseUrl: this.#url, headers: { authorization }, fetch: this.#fetch.bind(this) });
    } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError("invalid-frame"); }
  }

  async #fetch(input, init) {
    try {
      if (this.#closed || this.#signal.aborted) reject("transport-failed");
      const remaining = Math.floor(this.#deadline - performance.now());
      if (remaining < 1 || ++this.#requests > this.#limits.requests) reject("budget-exhausted");
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== this.#url || url.username || url.password) reject("authority-denied");
      const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(remaining), ...(init?.signal ? [init.signal] : [])]);
      if (init?.body !== undefined) {
        if (typeof init.body !== "string") reject("invalid-frame");
        const bytes = Buffer.byteLength(init.body);
        this.#sentBytes += bytes;
        if (bytes > this.#limits.inputBytes || this.#sentBytes > ceilings.maxInputBytes) reject("budget-exhausted");
      }
      const response = await fetch(input, { ...init, redirect: "error", signal });
      const reader = response.body?.getReader();
      const chunks = [];
      let count = 0;
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.byteLength; this.#bytes += value.byteLength;
          if (count > this.#limits.outputBytes || this.#bytes > this.#limits.totalResponseBytes) reject("budget-exhausted");
          chunks.push(value);
        }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      const bytes = Buffer.concat(chunks, count);
      if (response.status !== 204) {
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") reject("invalid-frame");
        parseJson(bytes);
      }
      return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: { "content-type": "application/json" } });
    } catch (error) {
      this.#transportError = error instanceof ProtocolError ? error : new ProtocolError("transport-failed");
      throw this.#transportError;
    }
  }

  #copy(value) {
    try { return parseJson(encodeJson(value, this.#limits.inputBytes)); }
    catch { reject("invalid-frame"); }
  }
  async #exclusive(operation, effect = false) {
    if (this.#busy || this.#closed || this.#signal.aborted) reject("transport-failed");
    this.#transportError = undefined;
    this.#busy = true;
    try {
      const result = await operation();
      if (this.#closed || this.#signal.aborted) reject("transport-failed");
      return result;
    }
    catch (error) {
      if (effect) reject("effect-unknown");
      if (this.#transportError) throw this.#transportError;
      throw error instanceof ProtocolError ? error : new ProtocolError("transport-failed");
    } finally { this.#busy = false; }
  }
  #requireReady() { if (!this.#ready) reject("custody-lost"); }
  async #probe() {
    this.#ready = false;
    const info = await this.#client.server.info();
    if (info.pid !== this.#server.pid || info.version !== this.#server.version) reject("custody-lost");
    this.#ready = true;
    return { pid: info.pid, version: info.version };
  }
  /** Version/PID readiness only; executable revision/custody is launcher evidence. */
  async probe() { return this.#exclusive(() => this.#probe()); }

  /** One create; caller preallocates and durably binds the session ID. */
  async start(configuration) {
    this.#requireReady();
    if (!this.#fresh) reject("effect-unknown");
    const config = this.#copy(configuration);
    if (!object(config) || Object.keys(config).some(key => !["model", "agent", "permissions"].includes(key))
        || !id(config.model?.providerID) || !id(config.model?.id) || !Array.isArray(config.permissions)
        || Object.keys(config.model).some(key => !["providerID", "id", "variant"].includes(key))
        || (config.model.variant !== undefined && !id(config.model.variant))) reject("invalid-frame");
    if (this.#started) reject("effect-unknown");
    this.#started = true;
    return this.#exclusive(async () => {
      await this.#probe();
      const result = await this.#client.session.create({ ...config, id: this.#sessionID, location: { directory: this.#directory } });
      this.#validateSession(result);
      // Pinned core/session/info.ts materializes an omitted variant as "default".
      if (Object.keys(config).some(key => !isDeepStrictEqual(result[key], key === "model" ? { variant: "default", ...config.model } : config[key]))) reject("custody-lost");
      this.#created = this.#copy(result);
      return result;
    }, true);
  }
  #validateSession(session) {
    if (session?.id !== this.#sessionID || session?.location?.directory !== this.#directory) reject("custody-lost");
  }

  /** One admit-only prompt, never POST-retried. At the selected engine revision,
   * resume:false prevents execution wakeup; this method does not start a review.
   */
  async submit(input) {
    this.#requireReady();
    if (!this.#created || this.#submitted || this.#interrupted) reject("effect-unknown");
    const prompt = this.#copy(input);
    if (!object(prompt) || Object.keys(prompt).some(key => !["id", "text", "files", "agents", "skills", "metadata", "delivery", "resume"].includes(key))
        || !id(prompt.id) || typeof prompt.text !== "string" || !["queue", "steer"].includes(prompt.delivery)
        || (prompt.resume !== undefined && prompt.resume !== false)) reject("invalid-frame");
    prompt.resume = false;
    this.#submitted = true;
    return this.#exclusive(async () => {
      await this.#probe();
      const result = await this.#client.session.prompt({ ...prompt, sessionID: this.#sessionID });
      const { id: inboxID, delivery, resume, ...payload } = prompt;
      if (result?.id !== inboxID || result?.sessionID !== this.#sessionID || result?.type !== "user"
          || result?.delivery !== delivery || !isDeepStrictEqual(result.payload, payload)) reject("custody-lost");
      this.#admitted = this.#copy(result);
      return result;
    }, true);
  }

  /** Release the original queued inbox input once, after the caller fsyncs Execute.
   * The selected engine wakes the whole session. The caller must exclude every
   * other writer; the bounded preflight is a drift check, not an atomic fence.
   * A successful PATCH is only a release receipt, never semantic completion.
   */
  async execute(inboxID) {
    this.#requireReady();
    if (!this.#fresh || !this.#admitted || this.#admitted.delivery !== "queue" || this.#executed || this.#interrupted) reject("effect-unknown");
    if (!id(inboxID) || inboxID !== this.#admitted.id) reject("invalid-frame");
    this.#executed = true;
    return this.#exclusive(async () => {
      await this.#probe();
      const snapshot = await this.#snapshot();
      if (snapshot.messages.length !== 0 || snapshot.inbox.length !== 1
          || !isDeepStrictEqual(snapshot.inbox[0], this.#admitted)
          || ["model", "agent", "permissions"].some(key => !isDeepStrictEqual(snapshot.session[key], this.#created[key]))) reject("custody-lost");
      await this.#client.session.inbox.update({ sessionID: this.#sessionID, inboxID, delivery: "steer" });
    }, true);
  }

  /** Explicit cancellation request; this receipt never proves process cleanup. */
  async interrupt() {
    this.#requireReady();
    if (this.#interrupted) reject("effect-unknown");
    this.#interrupted = true;
    return this.#exclusive(async () => {
      await this.#probe();
      const result = await this.#client.session.interrupt({ sessionID: this.#sessionID, resume: false });
      if (typeof result?.interrupted !== "boolean") reject("invalid-frame");
      return result;
    }, true);
  }

  async #snapshot() {
    const session = await this.#client.session.get({ sessionID: this.#sessionID });
    this.#validateSession(session);
    const inbox = await this.#client.session.inbox.list({ sessionID: this.#sessionID });
    if (!Array.isArray(inbox) || inbox.some(item => item.sessionID !== this.#sessionID || !id(item.id))) reject("custody-lost");
    const messages = [], cursors = new Set(), ids = new Set();
    let cursor;
    for (let page = 0; ; page++) {
      if (page >= this.#limits.pages) reject("budget-exhausted");
      const response = await this.#client.message.list({ sessionID: this.#sessionID, limit: Math.min(this.#limits.messages, 100), ...(cursor ? { cursor } : { order: "asc" }) });
      if (!Array.isArray(response?.data) || !response.cursor || messages.length + response.data.length > this.#limits.messages) reject("budget-exhausted");
      for (const message of response.data) {
        if (!id(message.id) || ids.has(message.id)) reject("effect-unknown");
        ids.add(message.id); messages.push(message);
      }
      cursor = response.cursor.next;
      if (cursor === undefined || cursor === null) break;
      if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor)) reject("effect-unknown");
      cursors.add(cursor);
    }
    return { session, inbox, messages };
  }

  /** Two matching bounded read-only scans, never a semantic completion claim.
   * Live-only event loss remains an explicit gap. No restart, resume, permission
   * approval, tool execution or new session occurs during reconciliation.
   */
  async reconcile() {
    this.#requireReady();
    return this.#exclusive(async () => {
      await this.#probe();
      const first = await this.#snapshot();
      const second = await this.#snapshot();
      if (!isDeepStrictEqual(first, second)) reject("effect-unknown");
      return { ...second, gap: true, complete: false };
    });
  }

  /** Terminal local cancellation; does not stop a server or attest cleanup. */
  close() { this.#closed = true; this.#ready = false; this.#abort.abort(); this.#client = undefined; }
}
