import { mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createRedactor,
  inspectDsn,
  parseDsn,
  type Artifact,
  type Context,
  type NotifyEventKind,
  type Run,
  type RunTrigger,
  type Target,
} from "@backupbot/core";
import { adapterFor } from "./adapters";
import type { Notifier } from "./notify";
import { pruneTarget } from "./retention";
import { RunLog, type LogLine } from "./runlog";
import type { JobContext, VerifyReport } from "./types";

export interface RunOutcome {
  run: Run;
  artifactPath?: string;
  artifact?: Artifact;
  verify?: VerifyReport;
  error?: string;
}

export interface ActiveRun {
  runId: number;
  targetId: number;
  targetSlug: string;
  startedAt: string;
  log: RunLog;
  abort: AbortController;
}

export class TargetBusyError extends Error {
  constructor(slug: string) {
    super(`a backup of "${slug}" is already running`);
    this.name = "TargetBusyError";
  }
}

export class Runner {
  private readonly active = new Map<number, ActiveRun>();

  constructor(
    private readonly ctx: Context,
    private readonly notifier?: Notifier,
  ) {}

  activeRuns(): ActiveRun[] {
    return [...this.active.values()];
  }

  activeForTarget(targetId: number): ActiveRun | undefined {
    return this.active.get(targetId);
  }

  findActiveRun(runId: number): ActiveRun | undefined {
    return this.activeRuns().find((r) => r.runId === runId);
  }

  cancel(runId: number): boolean {
    const active = this.findActiveRun(runId);
    if (!active) return false;
    active.log.write("cancellation requested");
    active.abort.abort();
    return true;
  }

  /** Replays what the run has logged so far, then streams the rest. */
  attach(runId: number, fn: (line: LogLine) => void): (() => void) | null {
    const active = this.findActiveRun(runId);
    if (!active) return null;
    for (const line of active.log.tail()) fn(line);
    return active.log.subscribe(fn);
  }

  /**
   * Starts a run and resolves as soon as the run row exists, handing back a
   * promise for the outcome. Lets the API return a run id immediately so the
   * caller can attach to the live log.
   */
  async start(target: Target, trigger: RunTrigger): Promise<{ runId: number; done: Promise<RunOutcome> }> {
    const started = Promise.withResolvers<number>();
    const done = this.run(target, trigger, (run) => started.resolve(run.id));
    done.catch((err) => started.reject(err));
    return { runId: await started.promise, done };
  }

  async run(target: Target, trigger: RunTrigger, onStart?: (run: Run) => void): Promise<RunOutcome> {
    if (this.active.has(target.id)) throw new TargetBusyError(target.slug);

    const { store, paths } = this.ctx;
    const run = store.startRun(target.id, trigger, null);
    const log = new RunLog(`${paths.logsDir}/${target.slug}/run-${run.id}.log`);
    store.setRunLogPath(run.id, log.path);

    const abort = new AbortController();
    onStart?.(run);
    this.active.set(target.id, {
      runId: run.id,
      targetId: target.id,
      targetSlug: target.slug,
      startedAt: run.startedAt,
      log,
      abort,
    });

    // The dump lands on a .partial path so an interrupted run can never be
    // mistaken for a usable backup, and is renamed only once verified.
    let partialPath: string | undefined;
    let outcome: RunOutcome | undefined;
    // Hoisted so the catch below can scrub too, and seeded with the raw DSN so
    // even a failure before it parses cannot leak the password.
    let redact = createRedactor([target.dsn]);
    try {
      const dsn = parseDsn(target.dsn);
      redact = createRedactor([target.dsn, dsn.password, encodeURIComponent(dsn.password)]);
      const write = (line: string) => log.write(redact(line));

      write(`starting ${trigger} backup of "${target.name}" (${target.engine})`);
      for (const warning of inspectDsn(dsn)) {
        write(`${warning.level}: ${warning.message}`);
        if (warning.level === "error") throw new Error(warning.message);
      }

      const adapter = adapterFor(target.engine);
      const finalPath = artifactPath(paths.backupsDir, target, await adapter.extension());
      partialPath = `${finalPath}.partial`;
      mkdirSync(dirname(finalPath), { recursive: true });

      const job: JobContext = { target, dsn, outPath: partialPath, log: write, redact, signal: abort.signal };
      const started = Date.now();
      const dumped = await adapter.dump(job);
      const sizeBytes = statSync(partialPath).size;
      write(`dump finished: ${sizeBytes} bytes in ${Math.round((Date.now() - started) / 1000)}s`);
      if (sizeBytes === 0) throw new Error("dump produced an empty file");

      const verify = await this.verify(adapter, job, target, write);
      if (verify && !verify.ok) throw new Error(`verification failed: ${verify.detail}`);

      await rename(partialPath, finalPath);
      partialPath = undefined;

      const sha256 = await hashFile(finalPath);
      const artifact = store.addArtifact({
        runId: run.id,
        targetId: target.id,
        path: finalPath,
        sizeBytes,
        sha256,
        format: dumped.format,
      });
      write(`stored ${finalPath}`);

      // Only prune after a success — a bad run must never age out good backups.
      await pruneTarget(store, target, write);

      const finished = store.finishRun(run.id, "success", { bytes: sizeBytes });
      write("backup complete");
      outcome = { run: finished, artifactPath: finalPath, artifact, verify };
      return outcome;
    } catch (err) {
      const cancelled = abort.signal.aborted;
      const message = cancelled ? "cancelled" : redact((err as Error).message ?? String(err));
      if (partialPath) await unlink(partialPath).catch(() => {});
      log.write(`FAILED: ${message}`);
      const finished = store.finishRun(run.id, cancelled ? "cancelled" : "failed", { error: message });
      outcome = { run: finished, error: message };
      return outcome;
    } finally {
      this.active.delete(target.id);
      if (outcome) await this.announce(target, outcome, (line) => log.write(line));
      await log.close();
    }
  }

  /**
   * Reports the finished run to every subscribed channel. Bounded and
   * swallowing: notification trouble is logged against the run, never raised.
   */
  private async announce(target: Target, outcome: RunOutcome, write: (line: string) => void): Promise<void> {
    if (!this.notifier) return;
    const kind = `run.${outcome.run.status}` as NotifyEventKind;
    try {
      const results = await this.notifier.dispatch({
        kind,
        target: this.ctx.store.toSafe(target),
        run: outcome.run,
        artifact: outcome.artifact,
        verify: outcome.verify,
        error: outcome.error,
      });
      for (const result of results) {
        write(result.ok ? `notified ${result.channelName}` : `notify ${result.channelName} failed: ${result.error}`);
      }
    } catch (err) {
      write(`notify failed: ${(err as Error).message}`);
    }
  }

  private async verify(
    adapter: ReturnType<typeof adapterFor>,
    job: JobContext,
    target: Target,
    write: (line: string) => void,
  ): Promise<VerifyReport | undefined> {
    if (target.verify === "none") return undefined;
    write(`verifying (${target.verify})`);
    const report = target.verify === "restore" ? await adapter.verifyRestore(job) : await adapter.verifyArchive(job);
    write(`verify ${report.ok ? "passed" : "FAILED"}: ${report.detail}`);
    return report;
  }
}

/** `<backups>/<slug>/<YYYY-MM>/<slug>-20260826T031500Z.dump` */
export function artifactPath(backupsDir: string, target: Target, extension: string, now = new Date()): string {
  const iso = now.toISOString();
  const stamp = iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${backupsDir}/${target.slug}/${iso.slice(0, 7)}/${target.slug}-${stamp}${extension}`;
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}
