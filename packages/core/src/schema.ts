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
