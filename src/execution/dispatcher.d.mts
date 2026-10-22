import type { Binding } from "./types.js";
import type { ChannelOptions } from "./channel.mjs";
import type { OpenCodeV2Options } from "./opencode-v2.mjs";
export interface InitialDispatcherOptions {
  binding: Binding;
  credentials: Omit<ChannelOptions, "role">;
  adapter: Omit<OpenCodeV2Options, "sessionID" | "mode">;
  /** Observation is the default; only original Rust admission may select fresh. */
  mode?: "fresh" | "observe";
  /** Independently validated current cancellation authority; never inferred on reopen. */
  interruptAuthority?: string;
  limits: { timeoutMs: number; inputBytes: number; records: number };
}
export class InitialDispatcher {
  constructor(options: InitialDispatcherOptions);
  handle(record: Uint8Array, sendTransfer?: (record: Uint8Array) => Promise<void>): Promise<Uint8Array | undefined>;
  close(): void;
}
