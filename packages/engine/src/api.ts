import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  channelConfigSchema,
  channelInputSchema,
  createRedactor,
  getSetting,
  inspectDsn,
  nextRunAt,
  parseDsn,
  randomToken,
  safeEqual,
  setSetting,
  targetInputSchema,
  validationMessage,
  type Context,
  type Target,
} from "@backupbot/core";
import { adapterFor } from "./adapters";
import type { Notifier } from "./notify";
import { TargetBusyError, type Runner } from "./runner";
import type { Scheduler } from "./scheduler";

const TOKEN_KEY = "api.token";

export function apiToken(ctx: Context): string {
  const fromEnv = process.env.BACKUPBOT_TOKEN;
  if (fromEnv) return fromEnv;
  const existing = getSetting(ctx.store.db, TOKEN_KEY);
  if (existing) return existing;
  const token = randomToken();
  setSetting(ctx.store.db, TOKEN_KEY, token);
  return token;
}

export interface ApiDeps {
  ctx: Context;
  runner: Runner;
  scheduler: Scheduler;
  token: string;
  notifier?: Notifier;
}

export function createApi({ ctx, runner, scheduler, notifier, token }: ApiDeps): Hono {
  const app = new Hono();
  const { store } = ctx;

  app.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(provided, token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const requireTarget = (ref: string): Target => {
    const target = store.resolveTarget(ref);
    if (!target) throw new HttpError(404, `no target "${ref}"`);
    return target;
  };

  /** A target plus everything the list view wants, without a second round trip. */
  const decorate = (target: Target) => {
    const [lastRun] = store.listRuns({ targetId: target.id, limit: 1 });
    const artifacts = store.listArtifacts({ targetId: target.id, limit: 10_000 });
    return {
      ...store.toSafe(target),
      lastRun: lastRun ?? null,
      nextRunAt: target.enabled ? (scheduler.nextRunFor(target.id) ?? nextRunAt(target.schedule, target.timezone)?.toISOString() ?? null) : null,
      running: runner.activeForTarget(target.id)?.runId ?? null,
      artifactCount: artifacts.length,
      totalBytes: artifacts.reduce((sum, a) => sum + a.sizeBytes, 0),
    };
  };

  app.get("/api/targets", (c) => c.json(store.listTargets().map(decorate)));

  app.get("/api/targets/:ref", (c) => c.json(decorate(requireTarget(c.req.param("ref")))));

  app.post("/api/targets", async (c) => {
    const target = store.createTarget(targetInputSchema.parse(await c.req.json()));
    scheduler.reload();
    return c.json(decorate(target), 201);
  });

  app.patch("/api/targets/:ref", async (c) => {
    const existing = requireTarget(c.req.param("ref"));
    const target = store.updateTarget(existing.id, targetInputSchema.partial().parse(await c.req.json()));
    scheduler.reload();
    return c.json(decorate(target));
  });

  app.delete("/api/targets/:ref", (c) => {
    const target = requireTarget(c.req.param("ref"));
    if (runner.activeForTarget(target.id)) throw new HttpError(409, "a backup of this target is running");
    store.deleteTarget(target.id);
    scheduler.reload();
    return c.json({ ok: true });
  });

  /** Dry-run the connection: version, chosen client binary, and DSN warnings. */
  app.post("/api/targets/:ref/test", async (c) => {
    const target = requireTarget(c.req.param("ref"));
    return c.json(await testConnection(target.dsn, target.engine));
  });

  /** Same check, but for a DSN the user is still typing in the TUI. */
  app.post("/api/test-connection", async (c) => {
    const body = (await c.req.json()) as { dsn?: string; engine?: Target["engine"] };
    if (!body.dsn) throw new HttpError(400, "dsn is required");
    const engine = body.engine ?? parseDsn(body.dsn).engine;
    return c.json(await testConnection(body.dsn, engine));
  });

  app.post("/api/targets/:ref/run", async (c) => {
    const target = requireTarget(c.req.param("ref"));
    try {
      const { runId, done } = await runner.start(target, "api");
      done.catch(() => {}); // outcome is read back through /api/runs
      return c.json({ runId }, 202);
    } catch (err) {
      if (err instanceof TargetBusyError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  app.get("/api/runs", (c) => {
    const targetRef = c.req.query("target");
    const targetId = targetRef ? requireTarget(targetRef).id : undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(store.listRuns({ targetId, limit: Math.min(limit, 500) }));
  });

  app.get("/api/runs/:id", (c) => {
    const run = store.getRun(Number(c.req.param("id")));
    if (!run) throw new HttpError(404, "no such run");
    return c.json(run);
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const cancelled = runner.cancel(Number(c.req.param("id")));
    if (!cancelled) throw new HttpError(409, "that run is not currently active");
    return c.json({ ok: true });
  });

  /**
   * Server-sent events: replays the in-memory tail, then streams live lines.
   * For a finished run it serves the log file and closes.
   */
  app.get("/api/runs/:id/log", async (c) => {
    const runId = Number(c.req.param("id"));
    const run = store.getRun(runId);
    if (!run) throw new HttpError(404, "no such run");
    const active = runner.findActiveRun(runId);

    if (!active) {
      const text = run.logPath ? await Bun.file(run.logPath).text().catch(() => "") : "";
      return c.json({ live: false, lines: text.split("\n").filter(Boolean) });
    }

    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = runner.attach(runId, (line) => {
        queue.push(JSON.stringify(line));
        wake?.();
      });
      try {
        while (runner.findActiveRun(runId)) {
          while (queue.length) await stream.writeSSE({ event: "line", data: queue.shift()! });
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 1000); // also acts as a keep-alive tick
          });
        }
        while (queue.length) await stream.writeSSE({ event: "line", data: queue.shift()! });
        await stream.writeSSE({ event: "end", data: JSON.stringify(store.getRun(runId)) });
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.get("/api/artifacts", (c) => {
    const targetRef = c.req.query("target");
    const targetId = targetRef ? requireTarget(targetRef).id : undefined;
    return c.json(store.listArtifacts({ targetId, limit: Number(c.req.query("limit") ?? 200) }));
  });

  app.get("/api/artifacts/:id/restore-command", (c) => {
    const artifact = store.getArtifact(Number(c.req.param("id")));
    if (!artifact) throw new HttpError(404, "no such artifact");
    const target = store.getTarget(artifact.targetId);
    if (!target) throw new HttpError(404, "the target for this artifact no longer exists");
    return c.json({ command: adapterFor(target.engine).restoreHint(artifact.path) });
  });

  app.get("/api/schedule", (c) => c.json(scheduler.entries()));

  // ---- notification channels ---------------------------------------------

  const requireChannel = (id: number) => {
    const channel = store.getChannel(id);
    if (!channel) throw new HttpError(404, `no channel with id ${id}`);
    return channel;
  };

  /** Env-configured channels are listed too, flagged as not editable. */
  app.get("/api/channels", (c) => {
    const stored = store.listChannels().map((ch) => store.toSafeChannel(ch));
    const fromEnv = (notifier?.channels() ?? []).filter((ch) => ch.id <= 0).map((ch) => store.toSafeChannel(ch, true));
    return c.json([...fromEnv, ...stored]);
  });

  app.post("/api/channels", async (c) => {
    const channel = store.createChannel(channelInputSchema.parse(await c.req.json()));
    return c.json(store.toSafeChannel(channel), 201);
  });

  app.patch("/api/channels/:id", async (c) => {
    const existing = requireChannel(Number(c.req.param("id")));
    const patch = channelInputSchema.partial().parse(await c.req.json());
    return c.json(store.toSafeChannel(store.updateChannel(existing.id, patch)));
  });

  app.delete("/api/channels/:id", (c) => {
    store.deleteChannel(requireChannel(Number(c.req.param("id"))).id);
    return c.json({ ok: true });
  });

  const requireNotifier = (): Notifier => {
    if (!notifier) throw new HttpError(503, "notifications are not enabled on this engine");
    return notifier;
  };

  /** Posts a "this works" message to a saved channel. */
  app.post("/api/channels/:id/test", async (c) => {
    const result = await requireNotifier().deliver(requireChannel(Number(c.req.param("id"))), { kind: "test" });
    return c.json(result, result.ok ? 200 : 502);
  });

  /** Same probe for a webhook the user is still typing into the TUI. */
  app.post("/api/channels/test", async (c) => {
    const body = (await c.req.json()) as { config?: unknown };
    const config = channelConfigSchema.parse(body.config);
    const ts = new Date().toISOString();
    const result = await requireNotifier().deliver(
      {
        id: -1,
        name: "preview",
        kind: config.kind,
        config,
        events: [],
        targets: null,
        enabled: true,
        lastSentAt: null,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
      },
      { kind: "test" },
    );
    return c.json(result, result.ok ? 200 : 502);
  });

  /** Everything the TUI dashboard header needs, in one call. */
  app.get("/api/stats", (c) => {
    const targets = store.listTargets();
    const recent = store.listRuns({ limit: 200 });
    const artifacts = store.listArtifacts({ limit: 10_000 });
    return c.json({
      targets: targets.length,
      enabled: targets.filter((t) => t.enabled).length,
      running: runner.activeRuns().length,
      failures24h: recent.filter(
        (r) => r.status === "failed" && Date.now() - new Date(r.startedAt).getTime() < 86_400_000,
      ).length,
      artifacts: artifacts.length,
      totalBytes: artifacts.reduce((sum, a) => sum + a.sizeBytes, 0),
    });
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    const invalid = validationMessage(err);
    if (invalid) return c.json({ error: invalid }, 400);
    return c.json({ error: err.message }, 500);
  });

  return app;
}

async function testConnection(dsn: string, engine: Target["engine"]) {
  const parsed = parseDsn(dsn);
  const redact = createRedactor([dsn, parsed.password]);
  const check = await adapterFor(engine).testConnection(parsed, redact);
  return { ...check, warnings: inspectDsn(parsed) };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
