// SPDX-License-Identifier: MIT — see mcp-admission.LICENSE.
import policy from "../contracts/mcp-admission-policy.v1.schema.json" with { type: "json" };
import binding from "../contracts/mcp-run-binding.v1.schema.json" with { type: "json" };

/** Language-neutral metadata; schema validity alone never grants authority. */
export const MCP_ADMISSION_LIMITS = Object.freeze({
  serversPerRun: 8,
  executionHostsPerServer: 64,
  identifierCharacters: 128,
  endpointCharacters: 2048,
  policyBytes: 64 * 1024,
});
export const MCP_ADMISSION_IDENTIFIER_PATTERN = policy.properties.servers.propertyNames.pattern;
export const mcpAdmissionPolicySchema = policy;
export const mcpRunBindingSchema = binding;
