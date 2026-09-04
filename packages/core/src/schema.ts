import { z } from "zod";

export const ENGINES = ["postgres", "mysql"] as const;
export type Engine = (typeof ENGINES)[number];

/** How thoroughly a finished dump is checked before it counts as a success. */
export const VERIFY_MODES = ["none", "archive", "restore"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export const RUN_STATUSES = ["running", "success", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ["schedule", "manual", "api"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * Grandfather-father-son retention. Each field is an independent bucket:
 * an artifact survives if any bucket still wants it.
 */
export const retentionSchema = z.object({
  keepLast: z.number().int().min(0).default(7),
  daily: z.number().int().min(0).default(7),
  weekly: z.number().int().min(0).default(4),
  monthly: z.number().int().min(0).default(6),
});
export type Retention = z.infer<typeof retentionSchema>;

export const DEFAULT_RETENTION: Retention = retentionSchema.parse({});

const slugRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Fields a user supplies when creating a target. */
export const targetInputSchema = z.object({
  name: z.string().min(1).max(64),
  slug: z
    .string()
    .regex(slugRe, "lowercase letters, digits and dashes only")
    .optional(),
  engine: z.enum(ENGINES),
  /** Plaintext connection string; encrypted before it touches disk. */
  dsn: z.string().min(1),
  /** 5-field cron expression, evaluated in `timezone`. */
  schedule: z.string().min(1),
  timezone: z.string().default("UTC"),
  retention: retentionSchema.default(DEFAULT_RETENTION),
  verify: z.enum(VERIFY_MODES).default("archive"),
  enabled: z.boolean().default(true),
});
export type TargetInput = z.input<typeof targetInputSchema>;

export const targetSchema = targetInputSchema.required({ slug: true }).extend({
  id: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Target = z.infer<typeof targetSchema>;

/** A target with its DSN stripped — safe to hand to the API or log. */
export type SafeTarget = Omit<Target, "dsn"> & { dsnMasked: string };

export interface Run {
  id: number;
  targetId: number;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  error: string | null;
  logPath: string | null;
}

export interface Artifact {
  id: number;
  runId: number;
  targetId: number;
  path: string;
  sizeBytes: number;
  sha256: string;
  format: string;
  createdAt: string;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!slugRe.test(slug)) throw new Error(`cannot derive a slug from ${JSON.stringify(name)}`);
  return slug;
}

// ---- notification channels -------------------------------------------------

export const CHANNEL_KINDS = ["discord"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * What a channel can subscribe to. `run.cancelled` is off by default: a
 * cancellation is something a human just did, not news worth a ping.
 */
export const NOTIFY_EVENTS = ["run.success", "run.failed", "run.cancelled"] as const;
export type NotifyEventKind = (typeof NOTIFY_EVENTS)[number];

export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEventKind[] = ["run.success", "run.failed"];

const DISCORD_WEBHOOK_RE = /^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export const discordConfigSchema = z.object({
  kind: z.literal("discord"),
  /** Server Settings → Integrations → Webhooks → Copy Webhook URL. */
  webhookUrl: z
    .string()
    .trim()
    .regex(DISCORD_WEBHOOK_RE, "expected https://discord.com/api/webhooks/<id>/<token>"),
  /** Overrides the name the webhook posts under. */
  username: z.string().max(80).optional(),
});

export const channelConfigSchema = z.discriminatedUnion("kind", [discordConfigSchema]);
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const channelInputSchema = z.object({
  name: z.string().min(1).max(64),
  config: channelConfigSchema,
  events: z
    .array(z.enum(NOTIFY_EVENTS))
    .min(1)
    .default(() => [...DEFAULT_NOTIFY_EVENTS]),
  /** Target slugs this channel cares about; null means every target. */
  targets: z.array(z.string()).min(1).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type ChannelInput = z.input<typeof channelInputSchema>;

export const channelSchema = channelInputSchema.extend({
  id: z.number().int(),
  kind: z.enum(CHANNEL_KINDS),
  lastSentAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

/**
 * A channel whose credentials are blanked — safe for the API, logs and TUI.
 * `readOnly` marks the ones configured by environment variable, which live in
 * the process rather than the database and so cannot be edited.
 */
export type SafeChannel = Channel & { readOnly: boolean };

export function maskChannelConfig(config: ChannelConfig): ChannelConfig {
  switch (config.kind) {
    case "discord":
      return { ...config, webhookUrl: maskWebhookUrl(config.webhookUrl) };
  }
}

/** Keeps the webhook id — enough to tell two channels apart — drops the token. */
export function maskWebhookUrl(url: string): string {
  const cut = url.lastIndexOf("/");
  return cut === -1 ? "****" : `${url.slice(0, cut)}/****`;
}

/** Accepts "failed", "success,failed", "run.failed" or "all". */
export function parseNotifyEvents(spec: string): NotifyEventKind[] {
  const parts = spec
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) throw new Error("no events given");
  if (parts.includes("all")) return [...NOTIFY_EVENTS];
  const events = parts.map((part) => {
    const full = part.startsWith("run.") ? part : `run.${part}`;
    if (!(NOTIFY_EVENTS as readonly string[]).includes(full)) {
      throw new Error(`unknown event "${part}" — expected one of ${NOTIFY_EVENTS.join(", ")} (or "all")`);
    }
    return full as NotifyEventKind;
  });
  return [...new Set(events)];
}

/**
 * A readable one-line form of a schema failure, or null if the error came from
 * somewhere else. Keeps zod's JSON dump out of API responses and the terminal.
 */
export function validationMessage(err: unknown): string | null {
  if (!(err instanceof z.ZodError)) return null;
  return err.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}
