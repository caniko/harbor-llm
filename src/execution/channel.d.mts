import type { Message } from "./types.js";
export interface ChannelOptions {
  key: Uint8Array;
  nonce: Uint8Array;
  binding: Uint8Array;
  role: "controller" | "bridge";
}
export class AuthenticatedChannel {
  constructor(options: ChannelOptions);
  seal(message: Message): Uint8Array;
  open(record: Uint8Array): Message;
  close(): void;
}
