// Synthetic conformance peer only. No launcher, provider or production custody.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
const { InitialDispatcher } = await import(pathToFileURL(process.argv[1]));
const journalPath = process.argv[2], fault = process.argv[3];
let dispatcher, server, pending = Buffer.alloc(0), ordinal = 0, session, inbox, released = false;
const timeout = setTimeout(() => process.exit(2), 10000);
try {
  read: for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    assert.ok(pending.length <= 131168);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE();
      assert.ok(length > 0 && length <= 65580);
      if (pending.length < length + 4) break;
      const record = pending.subarray(4, length + 4); pending = pending.subarray(length + 4);
      if (!dispatcher) {
        const setup = JSON.parse(record);
        const json = (res, data) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
        server = createServer(async (req, res) => {
          const chunks = []; let size = 0;
          for await (const bytes of req) { size += bytes.length; assert.ok(size <= 65536); chunks.push(bytes); }
          const body = size ? JSON.parse(Buffer.concat(chunks)) : undefined;
          if (req.method !== "GET") {
            const operation = req.method === "PATCH" ? "execute" : req.url.endsWith("/prompt") ? "submit" : "start";
            const journal = JSON.parse(readFileSync(journalPath));
            assert.ok(journal.operations[operation]);
            assert.equal(journal.operations[operation].receipt, null, "UNKNOWN must be durable before the HTTP effect");
            appendFileSync(journalPath.replace(/\.json$/, ".requests"), `${operation}\n`, { flush: true, mode: 0o600 });
          }
          if (req.url === "/api/info") return json(res, { pid: 123, version: "2.0.22" });
          if (req.method === "POST" && req.url === "/api/session") { session = { ...body, model: { variant: "default", ...body.model } }; return json(res, { data: session }); }
          if (req.url.endsWith("/prompt")) {
            assert.deepEqual(body, { text: "exact original input", id: "msg_original", delivery: "queue", resume: false });
            inbox = [{ id: body.id, sessionID: setup.binding.executionId, delivery: "queue", type: "user", payload: { text: body.text } }];
            return json(res, { data: inbox[0] });
          }
          if (req.method === "PATCH") {
            released = true; assert.deepEqual(body, { delivery: "steer" });
            if (fault === "lost-http") return res.destroy();
            res.writeHead(204); return res.end();
          }
          if (req.url.endsWith("/inbox")) return json(res, { data: inbox });
          if (req.url.includes("/message?")) return json(res, { data: [], cursor: {} });
          return json(res, { data: session });
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        dispatcher = new InitialDispatcher({ binding: setup.binding, credentials: { key: Uint8Array.from(setup.key), nonce: Uint8Array.from(setup.nonce), binding: Uint8Array.from(setup.digest) }, mode: "fresh",
          limits: { timeoutMs: 2000, inputBytes: 65536, records: 64 }, adapter: { url: `http://127.0.0.1:${server.address().port}`, authorization: "Basic synthetic-only", server: { pid: 123, version: "2.0.22" }, directory: "/sealed",
            limits: { timeoutMs: 2000, inputBytes: 65536, outputBytes: 65536, totalResponseBytes: 1048576, requests: 64, pages: 4, messages: 8 } } });
        continue;
      }
      if (++ordinal === 9 && fault === "bridge-exit") break read;
      let response;
      try { response = await dispatcher.handle(record); }
      catch (error) { if (fault === "lost-http" && released && error.code === "effect-unknown") break read; throw error; }
      if (released && fault === "lost-ipc") break read;
      if (response) {
        const header = Buffer.alloc(4); header.writeUInt32BE(response.length);
        process.stdout.write(Buffer.concat([header, response]));
      }
    }
  }
} catch {
  process.stderr.write("initial dispatch conformance peer failed\n"); process.exitCode = 1;
} finally {
  clearTimeout(timeout); dispatcher?.close(); server?.closeAllConnections(); server?.close(); process.stdin.destroy();
}
