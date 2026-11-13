// Minimal stdio LSP server for tests: an error on every document containing BAD.
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const publish = (uri, text) => send({
  method: "textDocument/publishDiagnostics",
  params: { uri, diagnostics: text.includes("BAD") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "BAD is not allowed" }] : [] },
});
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
    buffer = buffer.subarray(header + 4 + length);
    if (message.method === "initialize") send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
    else if (message.method === "shutdown") send({ id: message.id, result: null });
    else if (message.method === "exit") process.exit(0);
    else if (message.method === "textDocument/didOpen") publish(message.params.textDocument.uri, message.params.textDocument.text);
    else if (message.method === "textDocument/didChange") publish(message.params.textDocument.uri, message.params.contentChanges.at(-1).text);
    else if (message.id !== undefined && message.method) send({ id: message.id, result: null });
  }
});
