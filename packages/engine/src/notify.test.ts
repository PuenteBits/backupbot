import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  migrate,
  parseNotifyEvents,
  SecretBox,
  Store,
  type Channel,
  type Context,
  type Run,
  type SafeTarget,
} from "@backupbot/core";
import { discord, renderDiscord, type DiscordMessage } from "./notify/discord";
import { envChannels, Notifier } from "./notify";
import type { SendDeps } from "./notify/types";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/aToKeN-that-is-secret";

function testContext(): Context {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const store = new Store(db, new SecretBox(randomBytes(32)));
  return { store, paths: { dataDir: "", backupsDir: "", logsDir: "", dbFile: "", keyFile: "" } };
}

const target: SafeTarget = {
  id: 1,
  name: "Shop production",
  slug: "shop-prod",
  engine: "postgres",
  dsnMasked: "postgres://user:****@db.example.com:5432/shop",
  schedule: "0 3 * * *",
  timezone: "UTC",
  retention: { keepLast: 7, daily: 7, weekly: 4, monthly: 6 },
  verify: "archive",
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const run: Run = {
  id: 42,
  targetId: 1,
  status: "success",
  trigger: "schedule",
  startedAt: "2026-09-04T03:00:00.000Z",
  finishedAt: "2026-09-04T03:01:30.000Z",
  durationMs: 90_000,
  bytes: 5_242_880,
  error: null,
  logPath: "/data/logs/shop-prod/run-42.log",
};

const config = { kind: "discord", webhookUrl: WEBHOOK } as const;

/** A fetch stub that replays the given responses and records what was sent. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; body: DiscordMessage }[] = [];
  const deps: SendDeps = {
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as DiscordMessage });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next;
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

const ok = () => new Response("", { status: 204 });

describe("renderDiscord", () => {
  test("reports a success in green with size and duration", () => {
    const message = renderDiscord(config, {
      kind: "run.success",
      target,
      run,
      artifact: {
        id: 9,
        runId: 42,
        targetId: 1,
        path: "/backups/shop-prod/2026-09/shop-prod-20260904T030000Z.dump",
        sizeBytes: 5_242_880,
        sha256: "abc",
        format: "pg_custom",
        createdAt: run.finishedAt!,
      },
    });
    const [embed] = message.embeds;
    expect(embed!.color).toBe(0x2ecc71);
    expect(embed!.title).toContain("Shop production");
    const rendered = JSON.stringify(message);
    expect(rendered).toContain("5.0 MB");
    expect(rendered).toContain("1m 30s");
    expect(rendered).toContain("shop-prod-20260904T030000Z.dump");
  });

  test("reports a failure in red with the error", () => {
    const message = renderDiscord(config, {
      kind: "run.failed",
      target,
      run: { ...run, status: "failed", bytes: null, error: "pg_dump exited with code 1" },
      error: "pg_dump exited with code 1",
    });
    expect(message.embeds[0]!.color).toBe(0xe74c3c);
    expect(message.embeds[0]!.description).toContain("pg_dump exited with code 1");
  });

  test("truncates a runaway error rather than letting discord reject the post", () => {
    const message = renderDiscord(config, {
      kind: "run.failed",
      target,
      run: { ...run, status: "failed" },
      error: "x".repeat(10_000),
    });
    expect(message.embeds[0]!.description!.length).toBeLessThan(1_600);
  });

  test("never puts the target's connection string in the payload", () => {
    const message = renderDiscord(config, { kind: "run.success", target, run });
    expect(JSON.stringify(message)).not.toContain("db.example.com");
  });
});

describe("discord delivery", () => {
  test("posts the rendered message to the webhook", async () => {
    const { deps, calls } = stubFetch([ok()]);
    await discord.send(config, { kind: "test" }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK);
    expect(calls[0]!.body.embeds[0]!.title).toContain("test");
  });

  test("waits out a 429 and succeeds on the retry", async () => {
    const slept: number[] = [];
    const { deps, calls } = stubFetch([
      new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
      ok(),
    ]);
    await discord.send(config, { kind: "test" }, { ...deps, sleep: async (ms) => void slept.push(ms) });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1500]);
  });

  test("retries a 500 and gives up after three attempts", async () => {
    const { deps, calls } = stubFetch([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ]);
    await expect(discord.send(config, { kind: "test" }, deps)).rejects.toThrow("500");
    expect(calls).toHaveLength(3);
  });

  test("gives up immediately on a deleted webhook", async () => {
    const { deps, calls } = stubFetch([new Response("Unknown Webhook", { status: 404 })]);
    await expect(discord.send(config, { kind: "test" }, deps)).rejects.toThrow("404");
    expect(calls).toHaveLength(1);
  });
});

describe("Notifier", () => {
  const channel = (patch: Partial<Channel> = {}): Channel => ({
    id: 1,
    name: "ops",
    kind: "discord",
    config,
    events: ["run.success", "run.failed"],
    targets: null,
    enabled: true,
    lastSentAt: null,
    lastError: null,
    createdAt: "",
    updatedAt: "",
    ...patch,
  });

  test("only delivers to channels subscribed to the event", () => {
    const ctx = testContext();
    const notifier = new Notifier(ctx, [channel({ id: 0, events: ["run.failed"] })]);
    expect(notifier.matching({ kind: "run.failed", target, run })).toHaveLength(1);
    expect(notifier.matching({ kind: "run.success", target, run })).toHaveLength(0);
  });

  test("respects a channel scoped to particular targets", () => {
    const ctx = testContext();
    const notifier = new Notifier(ctx, [channel({ id: 0, targets: ["other-db"] })]);
    expect(notifier.matching({ kind: "run.success", target, run })).toHaveLength(0);
    expect(
      notifier.matching({ kind: "run.success", target: { ...target, slug: "other-db" }, run }),
    ).toHaveLength(1);
  });

  test("skips disabled channels", () => {
    const ctx = testContext();
    const notifier = new Notifier(ctx, [channel({ id: 0, enabled: false })]);
    expect(notifier.matching({ kind: "run.success", target, run })).toHaveLength(0);
  });

  test("reports a delivery failure instead of throwing at the caller", async () => {
    const ctx = testContext();
    const stored = ctx.store.createChannel({ name: "ops", config });
    const { deps } = stubFetch([new Response("Unknown Webhook", { status: 404 })]);
    const [result] = await new Notifier(ctx, [], deps).dispatch({ kind: "run.success", target, run });
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("404");
    // The failure is left on the channel so the UI can explain the silence.
    expect(ctx.store.getChannel(stored.id)!.lastError).toContain("404");
  });

  test("clears the last error once a delivery succeeds", async () => {
    const ctx = testContext();
    const stored = ctx.store.createChannel({ name: "ops", config });
    ctx.store.recordChannelResult(stored.id, "boom");
    const { deps } = stubFetch([ok()]);
    await new Notifier(ctx, [], deps).dispatch({ kind: "run.success", target, run });
    const after = ctx.store.getChannel(stored.id)!;
    expect(after.lastError).toBeNull();
    expect(after.lastSentAt).not.toBeNull();
  });
});

describe("channel storage", () => {
  test("round-trips a channel and masks the webhook token on the way out", () => {
    const ctx = testContext();
    const stored = ctx.store.createChannel({ name: "ops", config, targets: ["shop-prod"] });
    expect(stored.config).toEqual(config);
    expect(stored.events).toEqual(["run.success", "run.failed"]);

    const safe = ctx.store.toSafeChannel(stored);
    expect(JSON.stringify(safe)).not.toContain("aToKeN-that-is-secret");
    expect(safe.config.kind === "discord" && safe.config.webhookUrl).toContain("/123456789/****");
  });

  test("stores the webhook encrypted, not as plaintext in the row", () => {
    const ctx = testContext();
    ctx.store.createChannel({ name: "ops", config });
    const row = ctx.store.db.query("SELECT config_enc FROM channels").get() as { config_enc: string };
    expect(row.config_enc).not.toContain("aToKeN-that-is-secret");
  });

  test("rejects a URL that is not a discord webhook", () => {
    const ctx = testContext();
    expect(() =>
      ctx.store.createChannel({ name: "ops", config: { kind: "discord", webhookUrl: "https://example.com/hook" } }),
    ).toThrow();
  });

  test("an edit keeps the fields it was not given", () => {
    const ctx = testContext();
    const stored = ctx.store.createChannel({ name: "ops", config });
    const updated = ctx.store.updateChannel(stored.id, { events: ["run.failed"] });
    expect(updated.events).toEqual(["run.failed"]);
    expect(updated.config).toEqual(config);
    expect(updated.name).toBe("ops");
  });
});

describe("env configuration", () => {
  test("builds a channel from BACKUPBOT_DISCORD_WEBHOOK", () => {
    const [channel] = envChannels({ BACKUPBOT_DISCORD_WEBHOOK: WEBHOOK, BACKUPBOT_NOTIFY_EVENTS: "failed" });
    expect(channel!.id).toBe(0);
    expect(channel!.events).toEqual(["run.failed"]);
  });

  test("warns and carries on when the webhook URL is malformed", () => {
    const warnings: string[] = [];
    const channels = envChannels({ BACKUPBOT_DISCORD_WEBHOOK: "not-a-url" }, (m) => warnings.push(m));
    expect(channels).toHaveLength(0);
    expect(warnings[0]).toContain("BACKUPBOT_DISCORD_WEBHOOK");
  });

  test("keeps the default events when the event list is nonsense", () => {
    const warnings: string[] = [];
    const [channel] = envChannels(
      { BACKUPBOT_DISCORD_WEBHOOK: WEBHOOK, BACKUPBOT_NOTIFY_EVENTS: "explosions" },
      (m) => warnings.push(m),
    );
    expect(channel!.events).toEqual(["run.success", "run.failed"]);
    expect(warnings[0]).toContain("explosions");
  });
});

describe("parseNotifyEvents", () => {
  test("accepts shorthand, full names and all", () => {
    expect(parseNotifyEvents("failed")).toEqual(["run.failed"]);
    expect(parseNotifyEvents("success, run.failed")).toEqual(["run.success", "run.failed"]);
    expect(parseNotifyEvents("all")).toEqual(["run.success", "run.failed", "run.cancelled"]);
  });

  test("rejects an unknown event", () => {
    expect(() => parseNotifyEvents("explosions")).toThrow("explosions");
  });
});
