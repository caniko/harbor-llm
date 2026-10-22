import assert from "node:assert/strict";
import { test } from "node:test";
import conformance from "harbor-llm/contracts/mcp-admission-conformance.v1.json" with { type: "json" };
import policySchema from "harbor-llm/contracts/mcp-admission-policy.v1.schema.json" with { type: "json" };
import bindingSchema from "harbor-llm/contracts/mcp-run-binding.v1.schema.json" with { type: "json" };
import {
  bindMcpServersToRun, McpAdmissionError, requireMcpRunBinding,
  mcpAdmissionPolicySchema, mcpRunBindingSchema, MCP_ADMISSION_LIMITS, parseMcpAdmissionPolicy,
} from "harbor-llm/mcp-admission";

const server = {
  connectionId: "fixture-reader", name: "Fixture reader display name",
  url: "https://tools.example/mcp", token: "reader-secret", custom: "retained",
};
const policy = { version: 1, servers: { [server.connectionId]: {
  url: server.url, gatewayUrl: "https://worker.example/profile/main/",
  serverHostId: "worker", executionHostIds: ["worker", "remote"],
} } };
const input = { servers: [server], runId: "run-a", executionHostId: "worker", policy };
const blocked = (reason) => (error) => {
  assert.ok(error instanceof McpAdmissionError);
  assert.equal(error.code, "runtime_mcp_admission_blocked");
  assert.equal(error.reason, reason);
  return true;
};

test("portable schemas match the runtime's contract and limits", () => {
  assert.deepEqual(mcpAdmissionPolicySchema, policySchema);
  assert.deepEqual(mcpRunBindingSchema, bindingSchema);
  assert.equal(policySchema.properties.servers.additionalProperties.properties.executionHostIds.maxItems,
    MCP_ADMISSION_LIMITS.executionHostsPerServer);
  assert.equal(bindingSchema.properties.gatewayUrl.maxLength, MCP_ADMISSION_LIMITS.endpointCharacters);
});

for (const vector of conformance.cases) test(`conforms: ${vector.name}`, () => {
  const fixtureServer = { ...conformance.server,
    ...("connectionId" in vector ? { connectionId: vector.connectionId } : {}),
    ...("url" in vector ? { url: vector.url } : {}),
  };
  const fixturePolicy = { ...conformance.policy, servers: { fixture: {
    ...conformance.policy.servers.fixture,
    ...("gatewayUrl" in vector ? { gatewayUrl: vector.gatewayUrl } : {}),
  } } };
  const invoke = () => bindMcpServersToRun({ servers: [fixtureServer], runId: vector.runId,
    executionHostId: vector.executionHostId, policy: fixturePolicy });
  if ("expectedReason" in vector) assert.throws(invoke, blocked(vector.expectedReason));
  else assert.equal(invoke()[0].runBinding.authorizedCrossHost, vector.expectedCrossHost);
});

test("preserves display names, extensions and exact recipients without provider aliases", () => {
  const [bound] = bindMcpServersToRun(input);
  assert.deepEqual(bound, { ...server, runBinding: {
    runId: "run-a", executionHostId: "worker", serverHostId: "worker",
    gatewayUrl: policy.servers[server.connectionId].gatewayUrl, authorizedCrossHost: false,
  } });
  assert.equal(Object.hasOwn(server, "runBinding"), false);
  assert.equal(Object.isFrozen(bound.runBinding), true);
  const gatewayUrl = "http://127.0.0.1:9119/chat";
  assert.equal(bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
    [server.connectionId]: { ...policy.servers[server.connectionId], gatewayUrl },
  } } })[0].runBinding.gatewayUrl, gatewayUrl);
});

test("cross-host delivery requires the exact host in trusted policy", () => {
  assert.equal(bindMcpServersToRun({ ...input, executionHostId: "remote" })[0].runBinding.authorizedCrossHost, true);
  assert.throws(() => bindMcpServersToRun({ ...input, executionHostId: "other" }), blocked("execution_host_not_authorized"));
});

for (const override of [
  { policy: null }, { policy: {} }, { runId: "bad run" }, { executionHostId: undefined },
  { servers: [{ ...server, url: `${server.url}/` }] },
  { servers: [{ ...server, connectionId: "other" }] },
  { servers: [{ ...server, connectionId: "constructor" }] },
  { servers: [server, server] }, { servers: Array(9).fill(server) },
]) test(`fails closed: ${JSON.stringify(override)}`, () => {
  assert.throws(() => bindMcpServersToRun({ ...input, ...override }), McpAdmissionError);
});

for (const gatewayUrl of [
  "http://worker.example", "https://user:secret@worker.example", "https://worker.example?token=x",
  "https://worker.example#fragment", "file:///worker", " https://worker.example", "https://worker.example/\n",
]) test(`unsafe recipient: ${JSON.stringify(gatewayUrl)}`, () => {
  assert.throws(() => bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
    [server.connectionId]: { ...policy.servers[server.connectionId], gatewayUrl },
  } } }), blocked("unsafe_endpoint"));
});

test("rejects unknown policy fields and inherited decisions", () => {
  for (const invalid of [
    { ...policy, wildcard: true }, { ...policy, version: true },
    { ...policy, servers: { [server.connectionId]: { ...policy.servers[server.connectionId], allowAll: true } } },
    { ...policy, servers: Object.create(policy.servers) },
  ]) assert.throws(() => bindMcpServersToRun({ ...input, policy: invalid }), blocked("invalid_policy"));
});

test("rejects inherited execution-host array entries", () => {
  const executionHostIds = new Array(1);
  Object.setPrototypeOf(executionHostIds, Object.assign(Object.create(Array.prototype), { 0: "worker" }));
  assert.throws(() => bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
    [server.connectionId]: { ...policy.servers[server.connectionId], executionHostIds },
  } } }), blocked("invalid_policy"));
});

test("copies host entries without caller-controlled iterators", () => {
  const executionHostIds = ["worker"];
  executionHostIds[Symbol.iterator] = function* () { yield "unapproved"; };
  const parsed = bindMcpServersToRun({ ...input, policy: { ...policy, servers: {
    [server.connectionId]: { ...policy.servers[server.connectionId], executionHostIds },
  } } });
  assert.equal(parsed[0].runBinding.executionHostId, "worker");
});

test("requires no policy for an empty delivery", () => {
  assert.deepEqual(bindMcpServersToRun({ servers: [], runId: "", policy: null }), []);
});

test("malformed delivery containers and entries have finite errors", () => {
  for (const servers of [null, {}, "", { length: 0 }]) {
    assert.throws(() => bindMcpServersToRun({ ...input, servers }), blocked("invalid_policy"));
  }
  for (const servers of [[null], [1], [[]], new Array(1)]) {
    assert.throws(() => bindMcpServersToRun({ ...input, servers }), blocked("invalid_identity"));
  }
  assert.throws(() => bindMcpServersToRun(null), blocked("invalid_policy"));
});

test("every policy endpoint uses bounded ASCII, including unused rules", () => {
  const rule = policy.servers[server.connectionId];
  for (const url of ["\ud800", "😀".repeat(1025), "https://unused.example/é"]) {
    assert.throws(() => parseMcpAdmissionPolicy({ ...policy, servers: { ...policy.servers,
      unused: { ...rule, url } } }), blocked("invalid_policy"));
  }
  assert.equal(parseMcpAdmissionPolicy(JSON.parse('{"version":1.0,"servers":{}}')).version, 1);
});

test("replaces stale metadata without mutating the input", () => {
  const stale = { ...server, runBinding: { runId: "old-run" } };
  assert.equal(bindMcpServersToRun({ ...input, servers: [stale], runId: "new-run" })[0].runBinding.runId, "new-run");
  assert.equal(stale.runBinding.runId, "old-run");
});

test("rechecks run, execution identity and recipient at the consumer boundary", () => {
  const [bound] = bindMcpServersToRun(input);
  const expected = { runId: "run-a", executionHostId: "worker", gatewayUrl: bound.runBinding.gatewayUrl };
  const checked = requireMcpRunBinding(bound.runBinding, expected);
  assert.deepEqual(checked, bound.runBinding);
  assert.notEqual(checked, bound.runBinding);
  assert.equal(Object.isFrozen(checked), true);
  for (const override of [
    { runId: "run-b" }, { executionHostId: "remote" }, { gatewayUrl: "https://replacement.example/" },
  ]) assert.throws(() => requireMcpRunBinding(bound.runBinding, { ...expected, ...override }), blocked("binding_mismatch"));
  assert.throws(() => requireMcpRunBinding(undefined, expected), blocked("binding_mismatch"));
  assert.throws(() => requireMcpRunBinding({ ...bound.runBinding, serverHostId: "remote", authorizedCrossHost: false }, expected), blocked("binding_mismatch"));
});

test("requires an own cross-host approval under prototype pollution", () => {
  const [bound] = bindMcpServersToRun(input);
  const binding = { runId: "run-a", executionHostId: "worker", serverHostId: "remote", gatewayUrl: bound.runBinding.gatewayUrl };
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "authorizedCrossHost");
  try {
    Object.defineProperty(Object.prototype, "authorizedCrossHost", { value: true, configurable: true });
    assert.throws(() => requireMcpRunBinding(binding, binding), blocked("binding_mismatch"));
    assert.equal(requireMcpRunBinding({ ...binding, authorizedCrossHost: true }, binding).authorizedCrossHost, true);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "authorizedCrossHost", previous);
    else Reflect.deleteProperty(Object.prototype, "authorizedCrossHost");
  }
});

test("consumer recheck returns the frozen metadata it actually validated", () => {
  const [bound] = bindMcpServersToRun(input);
  const backing = { ...bound.runBinding };
  const trapped = new Proxy(backing, { get(_target, key) {
    return key === "runId" ? "different-run" : "http://external.example/?private";
  } });
  const checked = requireMcpRunBinding(trapped, bound.runBinding);
  assert.notEqual(checked, trapped);
  assert.deepEqual(checked, bound.runBinding);
  assert.equal(Object.isFrozen(checked), true);
  backing.runId = "replacement";
  assert.equal(checked.runId, "run-a");
});

test("inherited identities, endpoints and normalizers grant no authority", () => {
  const [bound] = bindMcpServersToRun(input);
  const properties = { normalizeRecipient: () => "inherited-alias", executionHostId: "worker",
    runId: "run-a", gatewayUrl: bound.runBinding.gatewayUrl, url: server.url };
  const previous = Object.fromEntries(Object.keys(properties).map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  try {
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(Object.prototype, key,
      { value, configurable: true });
    assert.throws(() => requireMcpRunBinding(bound.runBinding, { runId: "run-a", executionHostId: "worker",
      gatewayUrl: "https://different.example/api" }), blocked("binding_mismatch"));
    assert.throws(() => requireMcpRunBinding(bound.runBinding, {}), blocked("binding_mismatch"));
    const { executionHostId, ...missingHost } = input;
    assert.throws(() => bindMcpServersToRun(missingHost), blocked("invalid_identity"));
    const { url, ...missingUrl } = server;
    assert.throws(() => bindMcpServersToRun({ ...input, servers: [missingUrl] }), blocked("endpoint_mismatch"));
  } finally {
    for (const key of Object.keys(properties)) {
      if (previous[key]) Object.defineProperty(Object.prototype, key, previous[key]);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

test("policy accessors and descriptor traps never escape validation or redaction", () => {
  const rule = policy.servers[server.connectionId];
  for (const secondValue of ["non-ascii-é", { toJSON() { throw new Error("private-getter-marker"); } }]) {
    let reads = 0;
    const accessor = { ...rule, get url() { return ++reads === 1 ? rule.url : secondValue; } };
    assert.throws(() => parseMcpAdmissionPolicy({ ...policy, servers: { [server.connectionId]: accessor } }), blocked("invalid_policy"));
  }
  const trapped = new Proxy(policy, { ownKeys() { throw new Error("private-descriptor-marker"); } });
  assert.throws(() => parseMcpAdmissionPolicy(trapped), error => {
    blocked("invalid_policy")(error);
    assert.equal(String(error).includes("private"), false);
    return true;
  });
});

test("policy size accounting never executes inherited JSON serializers", () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true,
      value() { calls++; throw new Error("private-serializer-marker"); } });
    assert.deepEqual(parseMcpAdmissionPolicy(policy), policy);
    assert.equal(calls, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
    else Reflect.deleteProperty(Object.prototype, "toJSON");
  }
});

for (const throwOnCall of [1, 2]) test(`normalizer exception on call ${throwOnCall} stays content-free`, () => {
  const [bound] = bindMcpServersToRun(input);
  let calls = 0;
  assert.throws(() => requireMcpRunBinding(bound.runBinding, { ...bound.runBinding, normalizeRecipient: (url) => {
    if (++calls === throwOnCall) throw new Error(`private recipient: ${url}`);
    return url;
  } }), (error) => {
    blocked("binding_mismatch")(error);
    assert.equal(String(error).includes(bound.runBinding.gatewayUrl), false);
    assert.equal(String(error).includes("private recipient"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});

test("normalization requires two nonempty primitive strings", () => {
  const [bound] = bindMcpServersToRun(input);
  for (const result of [1, true, null, "", new String("same"), { toString() { throw new Error("private"); } }]) {
    assert.throws(() => requireMcpRunBinding(bound.runBinding, { ...bound.runBinding,
      normalizeRecipient: () => result }), blocked("binding_mismatch"));
  }
  for (const invalidCall of [1, 2]) {
    let calls = 0;
    assert.throws(() => requireMcpRunBinding(bound.runBinding, { ...bound.runBinding,
      normalizeRecipient: () => ++calls === invalidCall ? 1 : "same" }), blocked("binding_mismatch"));
  }
});

test("generic errors omit endpoints and caller credentials", () => {
  assert.throws(() => bindMcpServersToRun({ ...input, servers: [{ ...server, url: "https://unapproved.example/secret" }] }), (error) => {
    blocked("endpoint_mismatch")(error);
    assert.equal(String(error).includes("reader-secret"), false);
    assert.equal(String(error).includes("unapproved.example"), false);
    return true;
  });
});
