import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { bindMcpServersToRun, requireMcpRunBinding } from "harbor-llm/mcp-admission";

test("an independent authenticated MCP service consumes the public contract", async () => {
  const observed = [];
  const service = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    observed.push({ authorization: request.headers.authorization, method: rpc.method });
    response.writeHead(request.headers.authorization === "Bearer fixture-reader" ? 200 : 403,
      { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {
      content: [{ type: "text", text: "unrelated-service-result" }],
    } }));
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  try {
    const address = service.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const [server] = bindMcpServersToRun({
      servers: [{ connectionId: "weather-reader", name: "Weather lookup", url: endpoint, token: "fixture-reader" }],
      runId: "weather-run", executionHostId: "fixture-host", policy: { version: 1, servers: {
        "weather-reader": { url: endpoint, gatewayUrl: endpoint, serverHostId: "fixture-host", executionHostIds: ["fixture-host"] },
      } },
    });
    requireMcpRunBinding(server.runBinding, { runId: "weather-run", executionHostId: "fixture-host", gatewayUrl: endpoint });
    const response = await fetch(server.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2_000),
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "weather_lookup", arguments: { city: "Oslo" } } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.content[0].text, "unrelated-service-result");
    assert.throws(() => requireMcpRunBinding(server.runBinding, { runId: "another-run", executionHostId: "fixture-host", gatewayUrl: endpoint }));
    assert.deepEqual(observed, [{ authorization: "Bearer fixture-reader", method: "tools/call" }]);
    assert.equal(server.name, "Weather lookup");
  } finally {
    service.closeAllConnections();
    await new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
  }
});
