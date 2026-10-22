import { OpenCode } from "@opencode/client";
type Client = ReturnType<typeof OpenCode.make>;
type Create = NonNullable<Parameters<Client["session"]["create"]>[0]>;
export type OpenCodeV2Configuration = Pick<Create, "agent"> & {
  model: NonNullable<Create["model"]>;
  permissions: NonNullable<Create["permissions"]>;
};
export interface OpenCodeV2Limits {
  timeoutMs: number;
  inputBytes: number;
  outputBytes: number;
  totalResponseBytes: number;
  requests: number;
  pages: number;
  messages: number;
}
export interface OpenCodeV2Options {
  url: string;
  authorization: string;
  server: { pid: number; version: string };
  sessionID: string;
  directory: string;
  limits: OpenCodeV2Limits;
  signal?: AbortSignal;
  /** Defaults to observation. Fresh mode requires original admission and exclusive writer custody. */
  mode?: "fresh" | "observe";
}
export class OpenCodeV2 {
  constructor(options: OpenCodeV2Options);
  probe(): Promise<{ pid: number; version: string }>;
  start(configuration: OpenCodeV2Configuration): ReturnType<Client["session"]["create"]>;
  /** Durable inbox admission only; resume:false does not start model execution. */
  submit(input: Omit<Parameters<Client["session"]["prompt"]>[0], "sessionID" | "resume"> & { id: string; delivery: "steer" | "queue"; resume?: false }): ReturnType<Client["session"]["prompt"]>;
  /** One release of the original queued input, after its durable Execute reservation. */
  execute(inboxID: string): ReturnType<Client["session"]["inbox"]["update"]>;
  interrupt(): ReturnType<Client["session"]["interrupt"]>;
  reconcile(): Promise<{
    session: Awaited<ReturnType<Client["session"]["get"]>>;
    inbox: Awaited<ReturnType<Client["session"]["inbox"]["list"]>>;
    messages: Awaited<ReturnType<Client["message"]["list"]>>["data"];
    gap: true;
    complete: false;
  }>;
  close(): void;
}
