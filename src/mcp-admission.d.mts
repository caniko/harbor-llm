/** Delivery metadata, never a credential or independently authenticated grant. */
export interface McpRunBinding {
  readonly runId: string;
  readonly executionHostId: string;
  readonly serverHostId: string;
  /** Exact approved recipient; consumer aliases are supplied at its boundary. */
  readonly gatewayUrl: string;
  readonly authorizedCrossHost?: boolean;
}
export interface McpAdmissionServer {
  connectionId: string;
  url: string;
}
export interface McpAdmissionRule {
  url: string;
  gatewayUrl: string;
  serverHostId: string;
  executionHostIds: string[];
}
export interface McpAdmissionPolicy {
  version: 1;
  servers: Record<string, McpAdmissionRule>;
}
export type McpAdmissionReason =
  | "invalid_identity" | "invalid_policy" | "too_many_servers" | "duplicate_server"
  | "server_not_authorized" | "endpoint_mismatch" | "execution_host_not_authorized"
  | "unsafe_endpoint" | "binding_mismatch";
export declare class McpAdmissionError extends Error {
  readonly code: "runtime_mcp_admission_blocked";
  readonly reason: McpAdmissionReason;
  constructor(reason: McpAdmissionReason);
}
export declare function isMcpAdmissionIdentifier(value: unknown): value is string;
export declare function requireMcpCredentialEndpoint(value: unknown): string;
export declare function parseMcpAdmissionPolicy(value: unknown): McpAdmissionPolicy;
export declare function bindMcpServersToRun<T extends McpAdmissionServer>(input: {
  servers: readonly T[];
  runId: string;
  executionHostId?: string | null;
  policy?: unknown;
}): Array<Omit<T, "runBinding"> & { runBinding: McpRunBinding }>;
export declare function requireMcpRunBinding(value: unknown, expected: {
  runId: string;
  executionHostId: string;
  gatewayUrl: string;
  normalizeRecipient?: (url: string) => string | null;
}): McpRunBinding;
export { MCP_ADMISSION_LIMITS, mcpAdmissionPolicySchema, mcpRunBindingSchema } from "./mcp-admission-schema.mjs";
