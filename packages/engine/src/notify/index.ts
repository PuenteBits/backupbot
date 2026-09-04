import {
  DEFAULT_NOTIFY_EVENTS,
  discordConfigSchema,
  parseNotifyEvents,
  type Channel,
  type ChannelKind,
  type Context,
  type NotifyEventKind,
} from "@backupbot/core";
import { discord } from "./discord";
import type { ChannelProvider, DeliveryResult, NotificationEvent, SendDeps } from "./types";

export * from "./types";
export { renderDiscord, type DiscordMessage } from "./discord";

const PROVIDERS: Record<ChannelKind, ChannelProvider> = { discord };

export function providerFor(kind: ChannelKind): ChannelProvider {
  const provider = PROVIDERS[kind];
  if (!provider) throw new Error(`no notification provider for "${kind}"`);
  return provider;
}

const liveDeps: SendDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * Fans a finished run out to every channel that asked for it. Delivery never
 * throws: a dead webhook must not be able to turn a good backup into a failed
 * one, so every error is captured as a result and recorded on the channel.
 */
export class Notifier {
  constructor(
    private readonly ctx: Context,
    /** Channels configured by environment variable, which are not in the database. */
    private readonly envChannels: Channel[] = [],
    private readonly deps: SendDeps = liveDeps,
  ) {}

  channels(): Channel[] {
    return [...this.envChannels, ...this.ctx.store.listChannels()];
  }

  matching(event: NotificationEvent): Channel[] {
    const slug = event.target?.slug;
    return this.channels().filter(
      (channel) =>
        channel.enabled &&
        channel.events.includes(event.kind as NotifyEventKind) &&
        (channel.targets === null || (slug !== undefined && channel.targets.includes(slug))),
    );
  }

  async dispatch(event: NotificationEvent): Promise<DeliveryResult[]> {
    const channels = this.matching(event);
    if (!channels.length) return [];
    return Promise.all(channels.map((channel) => this.deliver(channel, event)));
  }

  /** Sends to one channel regardless of its filters — used by the test probe. */
  async deliver(channel: Channel, event: NotificationEvent): Promise<DeliveryResult> {
    const base = { channelId: channel.id, channelName: channel.name };
    try {
      await providerFor(channel.kind).send(channel.config, event, this.deps);
      this.record(channel, null);
      return { ...base, ok: true };
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      this.record(channel, error);
      return { ...base, ok: false, error };
    }
  }

  private record(channel: Channel, error: string | null): void {
    // Env channels have no row to update.
    if (channel.id <= 0) return;
    try {
      this.ctx.store.recordChannelResult(channel.id, error);
    } catch {
      // Bookkeeping only — never let it mask the delivery result.
    }
  }
}

/**
 * A Discord channel configured purely by environment, so a Docker deployment
 * can report to a webhook without anyone opening the TUI.
 */
export function envChannels(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): Channel[] {
  const webhookUrl = env.BACKUPBOT_DISCORD_WEBHOOK?.trim();
  if (!webhookUrl) return [];

  let events: NotifyEventKind[] = [...DEFAULT_NOTIFY_EVENTS];
  if (env.BACKUPBOT_NOTIFY_EVENTS) {
    try {
      events = parseNotifyEvents(env.BACKUPBOT_NOTIFY_EVENTS);
    } catch (err) {
      warn(`BACKUPBOT_NOTIFY_EVENTS ignored — ${(err as Error).message}`);
    }
  }

  const config = discordConfigSchema.safeParse({ kind: "discord", webhookUrl });
  if (!config.success) {
    warn(`BACKUPBOT_DISCORD_WEBHOOK ignored — ${config.error.issues[0]?.message ?? "invalid webhook URL"}`);
    return [];
  }

  const ts = new Date().toISOString();
  return [
    {
      id: 0,
      name: "discord (env)",
      kind: "discord",
      config: config.data,
      events,
      targets: null,
      enabled: true,
      lastSentAt: null,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    },
  ];
}
