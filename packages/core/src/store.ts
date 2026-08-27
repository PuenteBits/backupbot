import type { Database } from "bun:sqlite";
import type { SecretBox } from "./crypto";
import { maskDsn } from "./dsn";
import {
  DEFAULT_RETENTION,
  slugify,
  targetInputSchema,
  type Artifact,
  type Engine,
  type Retention,
  type Run,
  type RunStatus,
  type RunTrigger,
  type SafeTarget,
  type Target,
  type TargetInput,
  type VerifyMode,
} from "./schema";

interface TargetRow {
  id: number;
  name: string;
  slug: string;
  engine: string;
  dsn_enc: string;
  schedule: string;
  timezone: string;
  retention: string;
  verify: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  target_id: number;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  bytes: number | null;
  error: string | null;
  log_path: string | null;
}

interface ArtifactRow {
  id: number;
  run_id: number;
  target_id: number;
  path: string;
  size_bytes: number;
  sha256: string;
  format: string;
  created_at: string;
}

const now = () => new Date().toISOString();

export class Store {
  constructor(
    readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  // ---- targets ----------------------------------------------------------

  listTargets(): Target[] {
    return (this.db.query("SELECT * FROM targets ORDER BY name").all() as TargetRow[]).map((r) => this.toTarget(r));
  }

  getTarget(id: number): Target | null {
    const row = this.db.query("SELECT * FROM targets WHERE id = ?").get(id) as TargetRow | null;
    return row ? this.toTarget(row) : null;
  }

  getTargetBySlug(slug: string): Target | null {
    const row = this.db.query("SELECT * FROM targets WHERE slug = ?").get(slug) as TargetRow | null;
    return row ? this.toTarget(row) : null;
  }

  /** Accepts a numeric id or a slug — how humans actually refer to targets. */
  resolveTarget(ref: string | number): Target | null {
    const asNumber = typeof ref === "number" ? ref : /^\d+$/.test(ref) ? Number(ref) : null;
    return asNumber !== null ? this.getTarget(asNumber) : this.getTargetBySlug(String(ref));
  }

  createTarget(input: TargetInput): Target {
    const parsed = targetInputSchema.parse(input);
    const slug = parsed.slug ?? slugify(parsed.name);
    if (this.getTargetBySlug(slug)) throw new Error(`a target with slug "${slug}" already exists`);
    const ts = now();
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO targets (name, slug, engine, dsn_enc, schedule, timezone, retention, verify, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.name,
        slug,
        parsed.engine,
        this.box.encrypt(parsed.dsn),
        parsed.schedule,
        parsed.timezone,
        JSON.stringify(parsed.retention),
        parsed.verify,
        parsed.enabled ? 1 : 0,
        ts,
        ts,
      );
    return this.getTarget(Number(lastInsertRowid))!;
  }

  updateTarget(id: number, patch: Partial<TargetInput>): Target {
    const existing = this.getTarget(id);
    if (!existing) throw new Error(`no target with id ${id}`);
    const merged = targetInputSchema.parse({ ...existing, ...patch });
    const slug = patch.slug ?? existing.slug;
    const clash = this.getTargetBySlug(slug);
    if (clash && clash.id !== id) throw new Error(`a target with slug "${slug}" already exists`);
    this.db
      .query(
        `UPDATE targets SET name = ?, slug = ?, engine = ?, dsn_enc = ?, schedule = ?, timezone = ?,
           retention = ?, verify = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        slug,
        merged.engine,
        this.box.encrypt(merged.dsn),
        merged.schedule,
        merged.timezone,
        JSON.stringify(merged.retention),
        merged.verify,
        merged.enabled ? 1 : 0,
        now(),
        id,
      );
    return this.getTarget(id)!;
  }

  deleteTarget(id: number): void {
    this.db.query("DELETE FROM targets WHERE id = ?").run(id);
  }

  /** Strips the DSN. Everything leaving the process goes through here. */
  toSafe(target: Target): SafeTarget {
    const { dsn, ...rest } = target;
    return { ...rest, dsnMasked: maskDsn(dsn) };
  }

  // ---- runs -------------------------------------------------------------

  startRun(targetId: number, trigger: RunTrigger, logPath: string | null): Run {
    const { lastInsertRowid } = this.db
      .query("INSERT INTO runs (target_id, status, trigger, started_at, log_path) VALUES (?, 'running', ?, ?, ?)")
      .run(targetId, trigger, now(), logPath);
    return this.getRun(Number(lastInsertRowid))!;
  }

  finishRun(id: number, status: RunStatus, fields: { bytes?: number | null; error?: string | null } = {}): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`no run with id ${id}`);
    const finishedAt = now();
    const durationMs = new Date(finishedAt).getTime() - new Date(run.startedAt).getTime();
    this.db
      .query("UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, bytes = ?, error = ? WHERE id = ?")
      .run(status, finishedAt, durationMs, fields.bytes ?? null, fields.error ?? null, id);
    return this.getRun(id)!;
  }

  setRunLogPath(id: number, logPath: string): void {
    this.db.query("UPDATE runs SET log_path = ? WHERE id = ?").run(logPath, id);
  }

  getRun(id: number): Run | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : null;
  }

  listRuns(opts: { targetId?: number; limit?: number; status?: RunStatus } = {}): Run[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.targetId !== undefined) (where.push("target_id = ?"), args.push(opts.targetId));
    if (opts.status) (where.push("status = ?"), args.push(opts.status));
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(opts.limit ?? 50);
    return (
      this.db.query(`SELECT * FROM runs ${clause} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args) as RunRow[]
    ).map(toRun);
  }

  /**
   * Marks runs left in `running` by a crash as failed. Called at daemon start,
   * otherwise a killed container leaves phantom in-progress backups forever.
   */
  reapOrphanedRuns(): number {
    const orphans = this.listRuns({ status: "running", limit: 1000 });
    for (const run of orphans) {
      this.finishRun(run.id, "failed", { error: "interrupted: the daemon stopped while this run was in progress" });
    }
    return orphans.length;
  }

  // ---- artifacts --------------------------------------------------------

  addArtifact(a: Omit<Artifact, "id" | "createdAt">): Artifact {
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO artifacts (run_id, target_id, path, size_bytes, sha256, format, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.runId, a.targetId, a.path, a.sizeBytes, a.sha256, a.format, now());
    return this.db.query("SELECT * FROM artifacts WHERE id = ?").get(Number(lastInsertRowid)) as unknown as Artifact;
  }

  listArtifacts(opts: { targetId?: number; limit?: number } = {}): Artifact[] {
    const clause = opts.targetId !== undefined ? "WHERE target_id = ?" : "";
    const args: (string | number)[] = opts.targetId !== undefined ? [opts.targetId] : [];
    args.push(opts.limit ?? 500);
    return (
      this.db
        .query(`SELECT * FROM artifacts ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...args) as ArtifactRow[]
    ).map(toArtifact);
  }

  getArtifact(id: number): Artifact | null {
    const row = this.db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | null;
    return row ? toArtifact(row) : null;
  }

  deleteArtifact(id: number): void {
    this.db.query("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  private toTarget(row: TargetRow): Target {
    let retention: Retention;
    try {
      retention = JSON.parse(row.retention) as Retention;
    } catch {
      retention = DEFAULT_RETENTION;
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      engine: row.engine as Engine,
      dsn: this.box.decrypt(row.dsn_enc),
      schedule: row.schedule,
      timezone: row.timezone,
      retention,
      verify: row.verify as VerifyMode,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    targetId: row.target_id,
    status: row.status as RunStatus,
    trigger: row.trigger as RunTrigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    bytes: row.bytes,
    error: row.error,
    logPath: row.log_path,
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    targetId: row.target_id,
    path: row.path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    format: row.format,
    createdAt: row.created_at,
  };
}
