import { createContext } from "@backupbot/core";
import { apiToken, createApi } from "./api";
import { envChannels, Notifier } from "./notify";
import { Runner } from "./runner";
import { Scheduler } from "./scheduler";

export * from "./adapters";
export * from "./notify";
export * from "./retention";
export * from "./runner";
export * from "./runlog";
export * from "./scheduler";
export * from "./tools";
export * from "./types";
export { apiToken, createApi } from "./api";

export function startDaemon() {
  const ctx = createContext();
  // Bind to loopback by default: reach it from another machine over an SSH
  // tunnel rather than exposing a backup control plane on the LAN.
  const host = process.env.BACKUPBOT_HOST ?? "127.0.0.1";
  const port = Number(process.env.BACKUPBOT_PORT ?? 7817);

  const reaped = ctx.store.reapOrphanedRuns();
  if (reaped) console.log(`recovered ${reaped} run(s) interrupted by a previous shutdown`);

  const notifier = new Notifier(ctx, envChannels());
  const runner = new Runner(ctx, notifier);
  const scheduler = new Scheduler(ctx, runner);
  const token = apiToken(ctx);
  const app = createApi({ ctx, runner, scheduler, notifier, token });

  scheduler.reload();
  const server = Bun.serve({ hostname: host, port, fetch: app.fetch, idleTimeout: 0 });

  console.log(`backupbot engine listening on http://${host}:${port}`);
  console.log(`  data     ${ctx.paths.dataDir}`);
  console.log(`  backups  ${ctx.paths.backupsDir}`);
  if (!process.env.BACKUPBOT_TOKEN) console.log(`  token    ${token}`);
  for (const channel of notifier.channels()) {
    const scope = channel.targets ? channel.targets.join(", ") : "all targets";
    console.log(`  notify   ${channel.name} [${channel.kind}] ${channel.events.join(", ")} · ${scope}`);
  }
  for (const entry of scheduler.entries()) {
    console.log(`  schedule ${entry.slug}: ${entry.expression} (${entry.timezone}) → next ${entry.nextRunAt ?? "never"}`);
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down`);
    scheduler.stop();
    for (const active of runner.activeRuns()) {
      console.log(`  cancelling run ${active.runId} (${active.targetSlug})`);
      runner.cancel(active.runId);
    }
    // Give in-flight runs a moment to unwind and mark themselves cancelled.
    const deadline = Date.now() + 15_000;
    while (runner.activeRuns().length && Date.now() < deadline) await Bun.sleep(200);
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { ctx, runner, scheduler, server, token };
}

if (import.meta.main) startDaemon();
