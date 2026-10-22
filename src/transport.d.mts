export interface TransportLimits {
  timeoutMs: number;
  inputBytes: number;
  outputBytes: number;
  stderrBytes: number;
}
export interface TransportOptions {
  input?: unknown;
  limits: TransportLimits;
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
}
export type TransportErrorCode = "invalid-options" | "input-limit" | "output-limit" | "stderr-limit"
  | "timeout" | "cancelled" | "spawn-failed" | "input-failed" | "output-failed"
  | "exit-failed" | "invalid-json" | "cleanup-unverified";
export class TransportError extends Error { readonly code: TransportErrorCode; constructor(code: TransportErrorCode); }
export function runJson(binary: string, args: readonly string[], options: TransportOptions): Promise<unknown>;
