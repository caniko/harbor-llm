import type { Message } from "./types.js";
export function frame(message: Message): Uint8Array;
export class FrameDecoder {
  push(bytes: Uint8Array): Message[];
  end(): void;
}
