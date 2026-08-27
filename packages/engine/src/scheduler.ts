import { Cron } from "croner";
import type { Context, Target } from "@backupbot/core";
import { TargetBusyError, type Runner } from "./runner";

export interface ScheduleEntry {
  targetId: number;
  slug: string;
  expression: string;
  timezone: string;
  nextRunAt: string | null;
}

/**
 * Owns one croner job per enabled target. `reload()` is the single way
 * schedules change, so the TUI adding a target just calls it — no restart,
 * and no second source of truth in DSM's task scheduler.
 */
export class Scheduler {
  private jobs = new Map<number, Cron>();

  constructor(
    private readonly ctx: Context,
    private readonly runner: Runner,
    private readonly log: (line: string) => void = console.log,
  ) {}

  reload(): ScheduleEntry[] {
    this.stop();
    for (const target of this.ctx.store.listTargets()) {
      if (!target.enabled) continue;
      try {
        this.jobs.set(target.id, this.schedule(target));
      } catch (err) {
        this.log(`scheduler: skipping "${target.slug}" — ${(err as Error).message}`);
      }
    }
    this.log(`scheduler: ${this.jobs.size} target(s) scheduled`);
    return this.entries();
  }

  private schedule(target: Target): Cron {
    return new Cron(
      target.schedule,
      { timezone: target.timezone, name: target.slug, protect: true },
      async () => {
        // Re-read the target: it may have been edited since the job was created.
        const current = this.ctx.store.getTarget(target.id);
        if (!current || !current.enabled) return;
        try {
          const outcome = await this.runner.run(current, "schedule");
          this.log(
            outcome.error
              ? `scheduler: "${current.slug}" failed — ${outcome.error}`
              : `scheduler: "${current.slug}" succeeded (${outcome.run.bytes ?? 0} bytes)`,
          );
        } catch (err) {
          if (err instanceof TargetBusyError) {
            this.log(`scheduler: skipping "${current.slug}" — previous run still in progress`);
            return;
          }
          this.log(`scheduler: "${current.slug}" errored — ${(err as Error).message}`);
        }
      },
    );
  }

  entries(): ScheduleEntry[] {
    return [...this.jobs.entries()].map(([targetId, job]) => ({
      targetId,
      slug: job.name ?? String(targetId),
      expression: job.getPattern() ?? "",
      timezone: job.options.timezone ?? "UTC",
      nextRunAt: job.nextRun()?.toISOString() ?? null,
    }));
  }

  nextRunFor(targetId: number): string | null {
    return this.jobs.get(targetId)?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
