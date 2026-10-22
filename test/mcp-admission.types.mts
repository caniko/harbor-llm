import { bindMcpServersToRun, mcpAdmissionPolicySchema, mcpRunBindingSchema } from "harbor-llm/mcp-admission";

// These nested literals were part of the original public schema contract.
const endpointLimit: 2048 = mcpRunBindingSchema.properties.gatewayUrl.maxLength;
const hostLimit: 64 = mcpAdmissionPolicySchema.properties.servers.additionalProperties.properties.executionHostIds.maxItems;
const required: readonly ["version", "servers"] = mcpAdmissionPolicySchema.required;
const pattern: "^[\\u0021-\\u007e]{1,128}(?![\\s\\S])" = mcpRunBindingSchema.properties.runId.pattern;

const [bound] = bindMcpServersToRun({
  servers: [{ connectionId: "reader", url: "https://tools.example/mcp", custom: "retained" as const,
    runBinding: { runId: "stale" as const } }],
  runId: "fresh", executionHostId: "worker", policy: undefined,
});
const retained: "retained" = bound.custom;
const fresh: typeof bound.runBinding = { ...bound.runBinding, runId: "different-fresh-run" };
void [endpointLimit, hostLimit, required, pattern, retained, fresh];
