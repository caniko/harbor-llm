import type { Capability, ErrorCode, Message } from "./types.js";
export type * from "./types.js";
export const schema: Readonly<{ version: number; maxFrameBytes: number; maxJsonInteger: number; definitions: Readonly<Record<string, unknown>>; root: string }>;
export const schemaDigest: string;
export class ProtocolError extends Error { readonly code: ErrorCode; constructor(code: ErrorCode); }
export function decode(bytes: Uint8Array): Message;
export function encode(message: Message): Uint8Array;
export function negotiate(request: Message, response: Message, required: Capability[]): void;
