import { basename } from "node:path";
import { formatBytes, formatDuration, type ChannelConfig } from "@backupbot/core";
import type { ChannelProvider, NotificationEvent, SendDeps } from "./types";

const ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;
/** Discord's own ceiling is 4096 for a description; stay well inside it. */
const DESCRIPTION_MAX = 1_500;
const FIELD_MAX = 1_024;

const STYLE: Record<string, { color: number; emoji: string; verb: string }> = {
  "run.success": { color: 0x2ecc71, emoji: "✅", verb: "backup succeeded" },
  "run.failed": { color: 0xe74c3c, emoji: "🚨", verb: "backup FAILED" },
  "run.cancelled": { color: 0x95a5a6, emoji: "🛑", verb: "backup cancelled" },
  test: { color: 0x5865f2, emoji: "🔔", verb: "test notification" },
};

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordMessage {
  username?: string;
  embeds: {
    title: string;
    description?: string;
    color: number;
    timestamp?: string;
    fields?: Field[];
    footer?: { text: string };
  }[];
}

export function renderDiscord(config: ChannelConfig, event: NotificationEvent): DiscordMessage {
  if (config.kind !== "discord") throw new Error(`discord provider got a ${config.kind} config`);
  const style = STYLE[event.kind] ?? STYLE.test!;
  const { target, run } = event;

  if (event.kind === "test" || !run || !target) {
    return {
      username: config.username,
      embeds: [
        {
          title: `${style.emoji} backupbot test notification`,
          description: "If you can read this, backups will report here.",
          color: style.color,
        },
      ],
    };
  }

  const fields: Field[] = [
    { name: "Target", value: `${target.name} (\`${target.slug}\`)`, inline: true },
    { name: "Engine", value: target.engine, inline: true },
    { name: "Trigger", value: run.trigger, inline: true },
    { name: "Duration", value: formatDuration(run.durationMs), inline: true },
  ];

  if (event.kind === "run.success") {
    fields.push({ name: "Size", value: formatBytes(run.bytes), inline: true });
    if (event.verify) {
      fields.push({ name: "Verify", value: `${event.verify.mode} — ${clip(event.verify.detail, 80)}`, inline: true });
    }
  }

  return {
    username: config.username,
    embeds: [
      {
        title: `${style.emoji} ${target.name} — ${style.verb}`,
        description: describe(event),
        color: style.color,
        timestamp: run.finishedAt ?? run.startedAt,
        fields,
        footer: { text: `backupbot · run #${run.id}` },
      },
    ],
  };
}

function describe(event: NotificationEvent): string | undefined {
  if (event.error) return `\`\`\`\n${clip(event.error, DESCRIPTION_MAX)}\n\`\`\``;
  if (event.artifact) return `\`${basename(event.artifact.path)}\``;
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const discord: ChannelProvider = {
  kind: "discord",
  async send(config, event, deps) {
    if (config.kind !== "discord") throw new Error(`discord provider got a ${config.kind} config`);
    await post(config.webhookUrl, renderDiscord(config, event), deps);
  },
};

/**
 * Retries the failures worth retrying — timeouts, 5xx, and Discord's own rate
 * limit, which comes back as a 429 carrying the wait in seconds. A 4xx means
 * the webhook is wrong or gone, so it fails immediately rather than in 30s.
 */
async function post(url: string, body: DiscordMessage, deps: SendDeps): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = `webhook request failed: ${(err as Error).message}`;
      if (attempt < ATTEMPTS) await deps.sleep(backoffMs(attempt));
      continue;
    }

    if (response.ok) return;
    const detail = await response.text().catch(() => "");
    lastError = `discord returned ${response.status}${detail ? `: ${clip(detail.trim(), 200)}` : ""}`;

    if (response.status === 429) {
      if (attempt < ATTEMPTS) await deps.sleep(retryAfterMs(response, detail) ?? backoffMs(attempt));
      continue;
    }
    if (response.status < 500) throw new Error(lastError);
    if (attempt < ATTEMPTS) await deps.sleep(backoffMs(attempt));
  }
  throw new Error(lastError || "webhook delivery failed");
}

const backoffMs = (attempt: number) => 1_000 * 2 ** (attempt - 1);

/** `{"retry_after": 1.5}` in the body, or a `retry-after` header, both seconds. */
function retryAfterMs(response: Response, body: string): number | null {
  let seconds: number | null = null;
  try {
    const parsed = JSON.parse(body) as { retry_after?: number };
    if (typeof parsed.retry_after === "number") seconds = parsed.retry_after;
  } catch {
    // Not JSON — fall through to the header.
  }
  if (seconds === null) {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header)) seconds = header;
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds, 0) * 1000, 30_000);
}
