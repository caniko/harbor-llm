// SPDX-License-Identifier: MIT — see mcp-admission.LICENSE.
import { MCP_ADMISSION_IDENTIFIER_PATTERN, MCP_ADMISSION_LIMITS } from "./mcp-admission-schema.mjs";
export { MCP_ADMISSION_LIMITS, mcpAdmissionPolicySchema, mcpRunBindingSchema } from "./mcp-admission-schema.mjs";

const remedies = {
  invalid_identity: "Select an explicit run and execution identity.",
  invalid_policy: "Provide a bounded version-1 operator-owned endpoint and host policy.",
  too_many_servers: "Reduce the admitted server set to the per-run limit.",
  duplicate_server: "Resolve each connection exactly once.",
  server_not_authorized: "Ask the operator to authorize the exact resolved connection.",
  endpoint_mismatch: "Resolve a fresh connection matching the operator-approved endpoint.",
  execution_host_not_authorized: "Ask the operator to authorize the selected execution host.",
  unsafe_endpoint: "Use an exact HTTPS or loopback HTTP endpoint without credentials, query or fragment.",
  binding_mismatch: "Resolve fresh admission for this run, execution host and credential recipient.",
};

export class McpAdmissionError extends Error {
  code = "runtime_mcp_admission_blocked";
  constructor(reason) {
    super(`Runtime MCP admission blocked. ${remedies[reason]}`);
    this.name = "McpAdmissionError";
    this.reason = reason;
  }
}

const identifierPattern = new RegExp(MCP_ADMISSION_IDENTIFIER_PATTERN);
export function isMcpAdmissionIdentifier(value) {
  return typeof value === "string" && identifierPattern.test(value);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function dataRecord(value, reason, required = [], optional = [], extensions = false) {
  try {
    if (!record(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!required.every((key) => Object.hasOwn(descriptors, key))) throw new Error();
    const entries = Reflect.ownKeys(descriptors).map((key) => {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")
        || (!extensions && !required.includes(key) && !optional.includes(key))) throw new Error();
      return [key, descriptor.value];
    });
    // No getters or inherited authorization fields are read or retained.
    return Object.fromEntries(entries);
  } catch { throw new McpAdmissionError(reason); }
}

function dataArray(value, reason, limit, overflowReason = reason, itemReason = reason) {
  let failure = reason;
  try {
    if (!Array.isArray(value)) throw new Error();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isInteger(length) || length < 0) throw new Error();
    if (length > limit) { failure = overflowReason; throw new Error(); }
    const result = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) { failure = itemReason; throw new Error(); }
      Object.defineProperty(result, index, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  } catch { throw new McpAdmissionError(failure); }
}

function endpointString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MCP_ADMISSION_LIMITS.endpointCharacters
    && !/[^\x00-\x7f]/.test(value);
}

/** Transport syntax only; no DNS resolution, grants or physical-host attestation. */
export function requireMcpCredentialEndpoint(value) {
  if (!endpointString(value) || /[^\x21-\x7e]/.test(value)
    || !/^https?:\/\//i.test(value) || /[\\?#]/.test(value)) throw new McpAdmissionError("unsafe_endpoint");
  let url;
  try { url = new URL(value); } catch { throw new McpAdmissionError("unsafe_endpoint"); }
  const authority = value.slice(value.indexOf("//") + 2).split("/")[0];
  const portableHost = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::[0-9]+)?$/i.exec(authority)?.[1];
  if (!portableHost || portableHost.endsWith("..")
    || (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && portableHost !== url.hostname)) throw new McpAdmissionError("unsafe_endpoint");
  if (!url.hostname || authority.includes("@") || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new McpAdmissionError("unsafe_endpoint");
  return value;
}

/** Parse trusted operator metadata without interpreting a consumer's domain grants. */
export function parseMcpAdmissionPolicy(value) {
  const input = dataRecord(value, "invalid_policy", ["version", "servers"]);
  if (input.version !== 1) throw new McpAdmissionError("invalid_policy");
  const servers = dataRecord(input.servers, "invalid_policy", [], [], true);
  const entries = Reflect.ownKeys(servers).map((id) => {
    const rule = dataRecord(servers[id], "invalid_policy", ["url", "gatewayUrl", "serverHostId", "executionHostIds"]);
    if (!isMcpAdmissionIdentifier(id)
      || !endpointString(rule.url) || !endpointString(rule.gatewayUrl) || !isMcpAdmissionIdentifier(rule.serverHostId)
    ) throw new McpAdmissionError("invalid_policy");
    const executionHostIds = dataArray(rule.executionHostIds, "invalid_policy", MCP_ADMISSION_LIMITS.executionHostsPerServer);
    if (!executionHostIds.length || !executionHostIds.every(isMcpAdmissionIdentifier)) throw new McpAdmissionError("invalid_policy");
    return [id, { url: rule.url, gatewayUrl: rule.gatewayUrl, serverHostId: rule.serverHostId, executionHostIds }];
  });
  const policy = { version: 1, servers: Object.fromEntries(entries) };
  // Serialize a prototype-free view of only validated primitive fields. Neither
  // caller accessors nor inherited toJSON callbacks participate in size accounting.
  try {
    const view = Object.assign(Object.create(null), { version: 1, servers: Object.create(null) });
    for (const [id, rule] of entries) {
      view.servers[id] = Object.assign(Object.create(null), rule, {
        executionHostIds: Object.setPrototypeOf(rule.executionHostIds.slice(), null),
      });
    }
    if (new TextEncoder().encode(JSON.stringify(view)).length > MCP_ADMISSION_LIMITS.policyBytes) throw new Error();
  } catch {
    throw new McpAdmissionError("invalid_policy");
  }
  return policy;
}

/** Bind resolved servers using trusted policy; no mutation, I/O or retained state. */
export function bindMcpServersToRun(input) {
  const data = dataRecord(input, "invalid_policy", ["servers"], [], true);
  const servers = dataArray(data.servers, "invalid_policy", MCP_ADMISSION_LIMITS.serversPerRun, "too_many_servers", "invalid_identity");
  if (!servers.length) return [];
  const executionHostId = Object.hasOwn(data, "executionHostId") ? data.executionHostId : undefined;
  const runId = Object.hasOwn(data, "runId") ? data.runId : undefined;
  if (!isMcpAdmissionIdentifier(executionHostId) || !isMcpAdmissionIdentifier(runId)) throw new McpAdmissionError("invalid_identity");
  const policy = parseMcpAdmissionPolicy(Object.hasOwn(data, "policy") ? data.policy : undefined);
  const ids = new Set();
  const result = [];
  for (const entry of servers) {
    const server = dataRecord(entry, "invalid_identity", [], [], true);
    if (!Object.hasOwn(server, "connectionId")
      || !isMcpAdmissionIdentifier(server.connectionId)) throw new McpAdmissionError("invalid_identity");
    if (ids.has(server.connectionId)) throw new McpAdmissionError("duplicate_server");
    ids.add(server.connectionId);
    if (!Object.hasOwn(policy.servers, server.connectionId)) throw new McpAdmissionError("server_not_authorized");
    const rule = policy.servers[server.connectionId];
    if (!Object.hasOwn(server, "url") || rule.url !== server.url) throw new McpAdmissionError("endpoint_mismatch");
    if (!rule.executionHostIds.includes(executionHostId)) throw new McpAdmissionError("execution_host_not_authorized");
    requireMcpCredentialEndpoint(rule.url);
    requireMcpCredentialEndpoint(rule.gatewayUrl);
    result.push({ ...server, runBinding: Object.freeze({ runId, executionHostId,
      serverHostId: rule.serverHostId, gatewayUrl: rule.gatewayUrl,
      authorizedCrossHost: rule.serverHostId !== executionHostId }) });
  }
  return result;
}

/** Consumer recheck; raw URLs are validated before consumer-owned alias rules. */
export function requireMcpRunBinding(value, expected) {
  const binding = dataRecord(value, "binding_mismatch", ["runId", "executionHostId", "serverHostId", "gatewayUrl"], ["authorizedCrossHost"]);
  const target = dataRecord(expected, "binding_mismatch", ["runId", "executionHostId", "gatewayUrl"], [], true);
  if (!isMcpAdmissionIdentifier(binding.runId) || !isMcpAdmissionIdentifier(binding.executionHostId)
    || !isMcpAdmissionIdentifier(target.runId) || !isMcpAdmissionIdentifier(target.executionHostId)
    || !isMcpAdmissionIdentifier(binding.serverHostId)
    || (Object.hasOwn(binding, "authorizedCrossHost") && typeof binding.authorizedCrossHost !== "boolean")
    || binding.runId !== target.runId || binding.executionHostId !== target.executionHostId
    || (binding.serverHostId !== binding.executionHostId
      && (!Object.hasOwn(binding, "authorizedCrossHost") || binding.authorizedCrossHost !== true))) throw new McpAdmissionError("binding_mismatch");
  const approved = requireMcpCredentialEndpoint(binding.gatewayUrl);
  const recipient = requireMcpCredentialEndpoint(target.gatewayUrl);
  const normalize = (Object.hasOwn(target, "normalizeRecipient") ? target.normalizeRecipient : undefined) ?? ((url) => url);
  try {
    const normalizedApproved = normalize(approved);
    const normalizedRecipient = normalize(recipient);
    if (typeof normalizedApproved !== "string" || typeof normalizedRecipient !== "string"
      || !normalizedApproved || !normalizedRecipient || normalizedApproved !== normalizedRecipient) throw new McpAdmissionError("binding_mismatch");
  } catch { throw new McpAdmissionError("binding_mismatch"); }
  return Object.freeze(binding);
}
