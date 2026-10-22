import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import conformance from "../contracts/mcp-admission-conformance.v1.json" with { type: "json" };
import { bindMcpServersToRun, parseMcpAdmissionPolicy, requireMcpCredentialEndpoint,
  requireMcpRunBinding, isMcpAdmissionIdentifier, MCP_ADMISSION_LIMITS } from "../src/mcp-admission.mjs";

const pythonImport = process.env.HARBOR_TEST_INSTALLED ? `
from pathlib import Path
import harbor_llm
assert Path(harbor_llm.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
` : `sys.path.insert(0, ${JSON.stringify(new URL("../python", import.meta.url).pathname)})`;

test("Python and ESM agree on portable vectors, endpoint parsing and malformed admission", () => {
  const inputs = conformance.cases.map((vector) => ({
    servers: [{ ...conformance.server, ...("url" in vector ? { url: vector.url } : {}),
      ...("connectionId" in vector ? { connectionId: vector.connectionId } : {}) }],
    runId: vector.runId, executionHostId: vector.executionHostId,
    policy: { ...conformance.policy, servers: { fixture: { ...conformance.policy.servers.fixture,
      ...("gatewayUrl" in vector ? { gatewayUrl: vector.gatewayUrl } : {}) } } },
  }));
  const baseline = inputs[0];
  for (const endpoint of ["https://worker.example:99999", "http://[0:0:0:0:0:0:0:1]:8000",
    "http://127.0.0.2", "https://worker.123", "https://127.01.0.1", "https://0x7f000001",
    "https://0xworker.example", "https://worker.example./mcp", "https://[::1]/mcp",
    "https://@worker.example", "https://worker.example:/mcp", "http://LOCALHOST:8000/mcp"]) {
    inputs.push({ ...baseline, policy: { version: 1, servers: { fixture: {
      ...baseline.policy.servers.fixture, gatewayUrl: endpoint } } } });
  }
  for (const executionHostIds of ["host-a", null, {}, [], ["host-a\n"], Array(65).fill("host-a")]) {
    inputs.push({ ...baseline, policy: { version: 1, servers: { fixture: {
      ...baseline.policy.servers.fixture, executionHostIds } } } });
  }
  for (const policy of [null, {}, { ...baseline.policy, version: true }, { ...baseline.policy, wildcard: true }]) {
    inputs.push({ ...baseline, policy });
  }
  inputs.push({ ...baseline, servers: [baseline.servers[0], baseline.servers[0]] });
  inputs.push({ ...baseline, servers: Array(9).fill(baseline.servers[0]) });
  for (const servers of [null, {}, "", { length: 0 }, [null], [1], [[]], []]) {
    inputs.push({ ...baseline, servers });
  }
  const js = inputs.map((input) => {
    try { return { bindings: bindMcpServersToRun(input).map((s) => s.runBinding) }; }
    catch (error) { return { reason: error.reason, code: error.code }; }
  });
  const python = JSON.parse(execFileSync(process.env.HARBOR_TEST_PYTHON ?? "python3", ["-I", "-c", `
import json, sys
${pythonImport}
from harbor_llm.mcp_admission import bind_mcp_servers_to_run, McpAdmissionError
out = []
for row in json.load(sys.stdin):
    try:
        result = bind_mcp_servers_to_run(servers=row['servers'], run_id=row['runId'],
                                        execution_host_id=row['executionHostId'], policy=row['policy'])
        out.append({'bindings': [dict(s['runBinding']) for s in result]})
    except McpAdmissionError as error:
        out.append({'reason': error.reason, 'code': error.code})
print(json.dumps(out))
`], { input: JSON.stringify(inputs), encoding: "utf8" }));
  assert.deepEqual(python, js);
});

function policyWithBytes(size) {
  const policy = { version: 1, servers: Object.fromEntries(Array.from({ length: 24 }, (_, i) =>
    [`entry-${i}`, { url: "x".repeat(2048), gatewayUrl: "x", serverHostId: "host-a", executionHostIds: ["host-a"] }])) };
  let remaining = size - Buffer.byteLength(JSON.stringify(policy));
  for (const rule of Object.values(policy.servers)) {
    const added = Math.min(remaining, 2047);
    rule.gatewayUrl += "x".repeat(added);
    remaining -= added;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(policy)), size);
  return policy;
}

test("all public semantic operations agree at policy and normalization boundaries", () => {
  const rows = [];
  const rule = conformance.policy.servers.fixture;
  const addPolicy = (policy, accepted) => rows.push({ operation: "policy", policyJson: JSON.stringify(policy), accepted });
  addPolicy(conformance.policy, true);
  rows.push({ operation: "policy", policyJson: '{"version":1.0,"servers":{}}', accepted: true });
  for (const version of [true, "1", 1.01, null]) addPolicy({ version, servers: {} }, false);
  for (const url of ["\ud800", "😀".repeat(1025), "https://unused.example/é",
    "x".repeat(2049)]) {
    addPolicy({ ...conformance.policy, servers: { ...conformance.policy.servers, unused: { ...rule, url } } }, false);
  }
  addPolicy({ ...conformance.policy, servers: { ...conformance.policy.servers, unused: { ...rule, url: "x".repeat(2048) } } }, true);
  addPolicy(policyWithBytes(MCP_ADMISSION_LIMITS.policyBytes), true);
  addPolicy(policyWithBytes(MCP_ADMISSION_LIMITS.policyBytes + 1), false);
  for (const value of ["run-a", "x".repeat(128), "x".repeat(129), "run-a\n", "😀", null, 1]) {
    rows.push({ operation: "identifier", value });
  }
  for (const vector of conformance.cases.filter(v => "gatewayUrl" in v)) {
    rows.push({ operation: "endpoint", value: vector.gatewayUrl, accepted: !("expectedReason" in vector) });
    const binding = { runId: "run-a", executionHostId: "host-a", serverHostId: "host-a", gatewayUrl: vector.gatewayUrl };
    rows.push({ operation: "binding", binding, expected: binding, accepted: !("expectedReason" in vector) });
  }
  const binding = { runId: "run-a", executionHostId: "host-a", serverHostId: "host-a", gatewayUrl: rule.gatewayUrl };
  const expected = { runId: "run-a", executionHostId: "host-a", gatewayUrl: rule.gatewayUrl };
  rows.push({ operation: "binding", binding, expected, accepted: true });
  for (const change of [{ runId: "old" }, { executionHostId: "host-b" }, { gatewayUrl: "https://other.example" }]) {
    rows.push({ operation: "binding", binding, expected: { ...expected, ...change }, accepted: false });
  }
  for (const value of [null, {}, { ...binding, authorizedCrossHost: 1 }, { ...binding, serverHostId: "host-b" }]) {
    rows.push({ operation: "binding", binding: value, expected, accepted: false });
  }
  for (const normalizeValue of [true, 1, "", null, {}, "alias"]) {
    rows.push({ operation: "binding", binding, expected, normalizeValue, accepted: normalizeValue === "alias" });
  }
  for (const throwAt of [1, 2]) rows.push({ operation: "binding", binding, expected, throwAt, accepted: false });
  const js = rows.map(row => {
    try {
      let value;
      if (row.operation === "policy") value = parseMcpAdmissionPolicy(JSON.parse(row.policyJson));
      if (row.operation === "identifier") value = isMcpAdmissionIdentifier(row.value);
      if (row.operation === "endpoint") value = requireMcpCredentialEndpoint(row.value);
      if (row.operation === "binding") {
        let count = 0;
        const normalizeRecipient = "normalizeValue" in row ? () => row.normalizeValue : row.throwAt ? url => {
          if (++count === row.throwAt) throw new Error("private-content");
          return url;
        } : undefined;
        value = requireMcpRunBinding(row.binding, { ...row.expected, normalizeRecipient });
      }
      return { value };
    } catch (error) { return { reason: error.reason, code: error.code }; }
  });
  for (let i = 0; i < rows.length; i++) {
    if ("accepted" in rows[i]) assert.equal("value" in js[i], rows[i].accepted, `row ${i}: ${JSON.stringify(rows[i])}`);
  }
  const python = JSON.parse(execFileSync(process.env.HARBOR_TEST_PYTHON ?? "python3", ["-I", "-c", `
import json, sys
${pythonImport}
from harbor_llm.mcp_admission import (parse_mcp_admission_policy, is_mcp_admission_identifier,
    require_mcp_credential_endpoint, require_mcp_run_binding, McpAdmissionError)
out = []
for row in json.load(sys.stdin):
    try:
        operation = row['operation']
        if operation == 'policy': value = parse_mcp_admission_policy(json.loads(row['policyJson']))
        elif operation == 'identifier': value = is_mcp_admission_identifier(row['value'])
        elif operation == 'endpoint': value = require_mcp_credential_endpoint(row['value'])
        else:
            count = 0
            def normalize(url):
                global count
                count += 1
                if count == row.get('throwAt'): raise RuntimeError('private-content')
                return row.get('normalizeValue', url)
            expected = row['expected']
            value = dict(require_mcp_run_binding(row['binding'], run_id=expected['runId'],
                execution_host_id=expected['executionHostId'], gateway_url=expected['gatewayUrl'],
                normalize_recipient=normalize if 'normalizeValue' in row or 'throwAt' in row else None))
        out.append({'value': value})
    except McpAdmissionError as error:
        out.append({'reason': error.reason, 'code': error.code})
print(json.dumps(out))
`], { input: JSON.stringify(rows), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  assert.deepEqual(python, js);
});
