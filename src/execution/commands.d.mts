import type { Command, TransferReference, TransferChunk, TransferEnd } from "./command-types.js";
import type { ChannelOptions } from "./channel.mjs";
export type * from "./command-types.js";
export const schemaDigest: string;
export const schema: Readonly<{ version: number; maxFrameBytes: number; maxInputBytes: number; maxOutputBytes: number; maxChunkBytes: number; maxChunks: number }>;
export function encode(value: Command): Uint8Array;
export function decode(bytes: Uint8Array): Command;
export class AuthenticatedChannel {
  constructor(options: ChannelOptions);
  seal(command: Command): Uint8Array;
  open(record: Uint8Array): Command;
  close(): void;
}
export class TransferReceiver {
  constructor(reference: TransferReference, limits: { maximumBytes: number; timeoutMs: number });
  push(chunk: TransferChunk): void;
  finish(end: TransferEnd): Uint8Array;
  close(): void;
}
