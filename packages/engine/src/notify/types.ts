import type { Artifact, ChannelConfig, ChannelKind, NotifyEventKind, Run, SafeTarget } from "@backupbot/core";
import type { VerifyReport } from "../types";

/**
 * Everything a channel might want to say about a finished run. `test` is the
 * "does this webhook work" probe, which has no run behind it.
 */
export interface NotificationEvent {
  kind: NotifyEventKind | "test";
  target?: SafeTarget;
  run?: Run;
  artifact?: Artifact;
  verify?: VerifyReport;
  error?: string;
}

/** Injected so delivery can be tested without a network or real waiting. */
export interface SendDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}

export interface ChannelProvider {
  kind: ChannelKind;
  send(config: ChannelConfig, event: NotificationEvent, deps: SendDeps): Promise<void>;
}

export interface DeliveryResult {
  channelId: number;
  channelName: string;
  ok: boolean;
  error?: string;
}
