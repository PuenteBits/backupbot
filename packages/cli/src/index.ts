#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  createContext,
  formatBytes,
  formatDuration,
  formatRelative,
  nextRunAt,
  parseDsn,
  parseNotifyEvents,
  inspectDsn,
  createRedactor,
  retentionSchema,
  validationMessage,
  type Context,
  type Engine,
  type Target,
} from "@backupbot/core";
import { adapterFor, envChannels, Notifier, pruneTarget, Runner, startDaemon } from "@backupbot/engine";
import { apiToken } from "@backupbot/engine";

const USAGE = `backupbot — scheduled database backups

  serve                          run the engine daemon (scheduler + API)
  token                          print the API token
  ls                             list targets
  add --name N --dsn URL [...]   add a target
  edit <ref> [--dsn URL ...]     change a target
  rm <ref>                       delete a target
  test <ref|--dsn URL>           check connectivity and client versions
  run <ref>                      back up now, streaming the log
  runs [<ref>] [--limit N]       recent run history
  artifacts [<ref>]              stored backups
  restore <artifactId>           print the command to restore an artifact
  prune <ref>                    apply the retention policy now
  channels                       list notification channels
  channel add|edit|rm|test       manage notification channels

add/edit flags:
  --name        display name
  --slug        directory name (defaults to a slug of --name)
  --dsn         connection string (postgres://… or mysql://…)
  --schedule    cron expression, default "0 3 * * *"
  --tz          IANA timezone for the schedule, default UTC
  --verify      none | archive | restore, default archive
  --retention   keepLast,daily,weekly,monthly — e.g. 7,7,4,6
  --disabled    add the target without scheduling it

channel flags:
  --kind        discord (the only provider so far)
  --url         the webhook URL
  --name        display name, default "discord"
  --events      success,failed,cancelled or all — default success,failed
  --targets     only notify for these target slugs — default every target

  e.g. backupbot channel add --kind discord --url https://discord.com/api/webhooks/…
       backupbot channel add --kind discord --url … --events failed --targets shop-prod
`;

const options = {
  name: { type: "string" },
  slug: { type: "string" },
  dsn: { type: "string" },
  engine: { type: "string" },
  schedule: { type: "string" },
  tz: { type: "string" },
  verify: { type: "string" },
  retention: { type: "string" },
  kind: { type: "string" },
  url: { type: "string" },
  events: { type: "string" },
  targets: { type: "string" },
  disabled: { type: "boolean" },
  enabled: { type: "boolean" },
  limit: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const { values: flags, positionals } = parseArgs({ args: Bun.argv.slice(2), options, allowPositionals: true });
const [command, ...rest] = positionals;

if (flags.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const commands: Record<string, (ctx: Context) => Promise<void> | void> = {
  serve: () => void startDaemon(),
  token: (ctx) => console.log(apiToken(ctx)),
  ls: listTargets,
  add: addTarget,
  edit: editTarget,
  rm: removeTarget,
  test: testTarget,
  run: runTarget,
  runs: listRuns,
  artifacts: listArtifacts,
  restore: restoreCommand,
  prune: pruneCommand,
  channels: listChannels,
  channel: channelCommand,
};

const handler = commands[command];
if (!handler) {
  console.error(`unknown command "${command}"\n`);
  console.log(USAGE);
  process.exit(1);
}

try {
  await handler(command === "serve" ? (undefined as never) : createContext());
} catch (err) {
  console.error(`error: ${validationMessage(err) ?? (err as Error).message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function requireTarget(ctx: Context, ref: string | undefined): Target {
  if (!ref) throw new Error("this command needs a target (id or slug)");
  const target = ctx.store.resolveTarget(ref);
  if (!target) throw new Error(`no target "${ref}"`);
  return target;
}

function parseRetention(spec: string) {
  const [keepLast, daily, weekly, monthly] = spec.split(",").map((n) => Number(n.trim()));
  return retentionSchema.parse({ keepLast, daily, weekly, monthly });
}

function targetFieldsFromFlags() {
  const fields: Record<string, unknown> = {};
  if (flags.name) fields.name = flags.name;
  if (flags.slug) fields.slug = flags.slug;
  if (flags.dsn) {
    fields.dsn = flags.dsn;
    fields.engine = (flags.engine as Engine) ?? parseDsn(flags.dsn).engine;
  } else if (flags.engine) {
    fields.engine = flags.engine;
  }
  if (flags.schedule) fields.schedule = flags.schedule;
  if (flags.tz) fields.timezone = flags.tz;
  if (flags.verify) fields.verify = flags.verify;
  if (flags.retention) fields.retention = parseRetention(flags.retention);
  if (flags.disabled) fields.enabled = false;
  if (flags.enabled) fields.enabled = true;
  return fields;
}

function listTargets(ctx: Context) {
  const targets = ctx.store.listTargets();
  if (flags.json) return void console.log(JSON.stringify(targets.map((t) => ctx.store.toSafe(t)), null, 2));
  if (!targets.length) return void console.log('no targets yet — add one with "backupbot add --name ... --dsn ..."');

  const rows = targets.map((t) => {
    const [last] = ctx.store.listRuns({ targetId: t.id, limit: 1 });
    return {
      slug: t.slug,
      engine: t.engine,
      schedule: `${t.schedule} ${t.timezone}`,
      last: last ? `${last.status} ${formatRelative(last.startedAt)}` : "never",
      next: t.enabled ? formatRelative(nextRunAt(t.schedule, t.timezone)?.toISOString()) : "disabled",
    };
  });
  printTable(rows, ["slug", "engine", "schedule", "last", "next"]);
}

function addTarget(ctx: Context) {
  if (!flags.dsn) throw new Error("--dsn is required");
  const target = ctx.store.createTarget({
    name: flags.name ?? parseDsn(flags.dsn).database,
    schedule: flags.schedule ?? "0 3 * * *",
    ...targetFieldsFromFlags(),
  } as Parameters<typeof ctx.store.createTarget>[0]);
  console.log(`added "${target.slug}" (${target.engine}), schedule ${target.schedule} ${target.timezone}`);
  for (const warning of inspectDsn(parseDsn(target.dsn))) console.log(`  ${warning.level}: ${warning.message}`);
  console.log(`  next run ${nextRunAt(target.schedule, target.timezone)?.toISOString() ?? "never"}`);
}

function editTarget(ctx: Context) {
  const target = requireTarget(ctx, rest[0]);
  const updated = ctx.store.updateTarget(target.id, targetFieldsFromFlags());
  console.log(`updated "${updated.slug}"`);
}

function removeTarget(ctx: Context) {
  const target = requireTarget(ctx, rest[0]);
  ctx.store.deleteTarget(target.id);
  console.log(`removed "${target.slug}" (stored backup files were left on disk)`);
}

async function testTarget(ctx: Context) {
  const dsn = flags.dsn ?? requireTarget(ctx, rest[0]).dsn;
  const parsed = parseDsn(dsn);
  const engine = (flags.engine as Engine) ?? parsed.engine;
  for (const warning of inspectDsn(parsed)) console.log(`${warning.level}: ${warning.message}`);
  const check = await adapterFor(engine).testConnection(parsed, createRedactor([dsn, parsed.password]));
  if (!check.ok) throw new Error(check.error ?? "connection failed");
  console.log(`ok — ${engine} ${check.serverVersion} at ${parsed.host}:${parsed.port}/${parsed.database}`);
  console.log(`     using ${check.client}`);
}

async function runTarget(ctx: Context) {
  const target = requireTarget(ctx, rest[0]);
  const runner = new Runner(ctx, notifier(ctx));
  const { runId, done } = await runner.start(target, "manual");
  runner.attach(runId, (line) => console.log(`  ${line.text}`));
  const outcome = await done;
  if (outcome.error) throw new Error(outcome.error);
  console.log(`\n${outcome.artifactPath}`);
  console.log(`${formatBytes(outcome.run.bytes)} in ${formatDuration(outcome.run.durationMs)}`);
}

function listRuns(ctx: Context) {
  const target = rest[0] ? requireTarget(ctx, rest[0]) : null;
  const runs = ctx.store.listRuns({ targetId: target?.id, limit: Number(flags.limit ?? 20) });
  if (!runs.length) return void console.log("no runs recorded yet");
  const slugs = new Map(ctx.store.listTargets().map((t) => [t.id, t.slug]));
  printTable(
    runs.map((r) => ({
      id: String(r.id),
      target: slugs.get(r.targetId) ?? "?",
      status: r.status,
      started: formatRelative(r.startedAt),
      took: formatDuration(r.durationMs),
      size: formatBytes(r.bytes),
      error: r.error ? r.error.slice(0, 60) : "",
    })),
    ["id", "target", "status", "started", "took", "size", "error"],
  );
}

function listArtifacts(ctx: Context) {
  const target = rest[0] ? requireTarget(ctx, rest[0]) : null;
  const artifacts = ctx.store.listArtifacts({ targetId: target?.id, limit: Number(flags.limit ?? 50) });
  if (!artifacts.length) return void console.log("no stored backups yet");
  const slugs = new Map(ctx.store.listTargets().map((t) => [t.id, t.slug]));
  printTable(
    artifacts.map((a) => ({
      id: String(a.id),
      target: slugs.get(a.targetId) ?? "?",
      created: formatRelative(a.createdAt),
      size: formatBytes(a.sizeBytes),
      path: a.path,
    })),
    ["id", "target", "created", "size", "path"],
  );
}

function restoreCommand(ctx: Context) {
  const artifact = ctx.store.getArtifact(Number(rest[0]));
  if (!artifact) throw new Error(`no artifact with id ${rest[0]}`);
  const target = ctx.store.getTarget(artifact.targetId);
  if (!target) throw new Error("the target for this artifact no longer exists");
  console.log(`# ${artifact.path}  (${formatBytes(artifact.sizeBytes)}, sha256 ${artifact.sha256.slice(0, 16)}…)`);
  console.log(`# set TARGET_DSN to the database you want to restore INTO — this overwrites it.`);
  console.log(adapterFor(target.engine).restoreHint(artifact.path));
}

async function pruneCommand(ctx: Context) {
  const target = requireTarget(ctx, rest[0]);
  const result = await pruneTarget(ctx.store, target, (line) => console.log(line));
  console.log(`kept ${result.kept}, deleted ${result.deleted.length}, freed ${formatBytes(result.freedBytes)}`);
}

// ---- notification channels ------------------------------------------------

function notifier(ctx: Context): Notifier {
  return new Notifier(ctx, envChannels());
}

function listChannels(ctx: Context) {
  const channels = notifier(ctx).channels();
  if (flags.json) {
    return void console.log(JSON.stringify(channels.map((ch) => ctx.store.toSafeChannel(ch, ch.id <= 0)), null, 2));
  }
  if (!channels.length) {
    return void console.log('no channels yet — add one with "backupbot channel add --kind discord --url ..."');
  }
  printTable(
    channels.map((ch) => ({
      id: ch.id > 0 ? String(ch.id) : "env",
      name: ch.name,
      kind: ch.kind,
      events: ch.events.map((e) => e.replace("run.", "")).join(","),
      targets: ch.targets?.join(",") ?? "all",
      state: ch.enabled ? "enabled" : "disabled",
      last: ch.lastError ? `error: ${ch.lastError.slice(0, 50)}` : ch.lastSentAt ? formatRelative(ch.lastSentAt) : "—",
    })),
    ["id", "name", "kind", "events", "targets", "state", "last"],
  );
}

function channelFieldsFromFlags() {
  const fields: Record<string, unknown> = {};
  if (flags.name) fields.name = flags.name;
  if (flags.url) fields.config = { kind: flags.kind ?? "discord", webhookUrl: flags.url };
  if (flags.events) fields.events = parseNotifyEvents(flags.events);
  if (flags.targets) fields.targets = flags.targets.split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.disabled) fields.enabled = false;
  if (flags.enabled) fields.enabled = true;
  return fields;
}

function requireChannel(ctx: Context, ref: string | undefined) {
  const channel = ref && /^\d+$/.test(ref) ? ctx.store.getChannel(Number(ref)) : null;
  if (!channel) throw new Error(`this command needs a channel id — see "backupbot channels"`);
  return channel;
}

async function channelCommand(ctx: Context) {
  const [action, ref] = rest;
  switch (action) {
    case "add": {
      if (!flags.url) throw new Error("--url is required");
      const channel = ctx.store.createChannel({
        name: flags.name ?? (flags.kind ?? "discord"),
        ...channelFieldsFromFlags(),
      } as Parameters<typeof ctx.store.createChannel>[0]);
      console.log(`added channel ${channel.id} "${channel.name}" (${channel.kind})`);
      console.log(`  events   ${channel.events.join(", ")}`);
      console.log(`  targets  ${channel.targets?.join(", ") ?? "all"}`);
      console.log(`  test it with "backupbot channel test ${channel.id}"`);
      return;
    }
    case "edit": {
      const existing = requireChannel(ctx, ref);
      const updated = ctx.store.updateChannel(existing.id, channelFieldsFromFlags());
      console.log(`updated channel ${updated.id} "${updated.name}"`);
      return;
    }
    case "rm": {
      const existing = requireChannel(ctx, ref);
      ctx.store.deleteChannel(existing.id);
      console.log(`removed channel ${existing.id} "${existing.name}"`);
      return;
    }
    case "test": {
      const existing = requireChannel(ctx, ref);
      const result = await notifier(ctx).deliver(existing, { kind: "test" });
      if (!result.ok) throw new Error(result.error ?? "delivery failed");
      console.log(`sent a test message to "${existing.name}"`);
      return;
    }
    default:
      throw new Error(`unknown channel command "${action ?? ""}" — expected add, edit, rm or test`);
  }
}

function printTable(rows: Record<string, string>[], columns: string[]) {
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((r) => (r[col] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(columns.map((c) => c.toUpperCase())));
  for (const row of rows) console.log(line(columns.map((c) => row[c] ?? "")));
}
