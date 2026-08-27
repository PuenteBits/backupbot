import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createContext, type Context } from "@backupbot/core";
import { createApi, Runner, Scheduler } from "@backupbot/engine";
import { Api } from "./api";
import { App } from "./app";

const TOKEN = "test-token";
const MYSQL_DSN = "mysql://root:rootpw@127.0.0.1:53306/shop";

/**
 * Two tests below drive a real dump against a real server. Everything else runs
 * without one, so a missing server skips those instead of failing the suite:
 *
 *   docker run -d --name bb-my -e MYSQL_ROOT_PASSWORD=rootpw \
 *     -e MYSQL_DATABASE=shop -p 53306:3306 mysql:8
 */
const MYSQL_UP = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 1500);
  const settle = (up: boolean) => {
    clearTimeout(timer);
    resolve(up);
  };
  Bun.connect({
    hostname: "127.0.0.1",
    port: 53306,
    socket: {
      data: () => {},
      open: (socket) => {
        socket.end();
        settle(true);
      },
      error: () => settle(false),
    },
  }).catch(() => settle(false));
});
if (!MYSQL_UP) console.warn("MySQL on 127.0.0.1:53306 not reachable — skipping the two live-server tests");

let workDir: string;
let ctx: Context;
let server: ReturnType<typeof Bun.serve>;
let api: Api;

beforeAll(() => {
  workDir = mkdtempSync(`${tmpdir()}/backupbot-tui-`);
  process.env.BACKUPBOT_DATA_DIR = `${workDir}/data`;
  process.env.BACKUPBOT_BACKUPS_DIR = `${workDir}/backups`;

  ctx = createContext();
  ctx.store.createTarget({
    name: "Shop MySQL",
    engine: "mysql",
    dsn: MYSQL_DSN,
    schedule: "0 3 * * *",
    timezone: "Europe/Madrid",
  });

  const runner = new Runner(ctx);
  const scheduler = new Scheduler(ctx, runner, () => {});
  const app = createApi({ ctx, runner, scheduler, token: TOKEN });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 0 });
  api = new Api(`http://127.0.0.1:${server.port}`, TOKEN);
});

afterEach(() => {
  // Each mounted App keeps a poll timer; tear them down so tests stay isolated.
  for (const setup of mounted.splice(0)) setup.renderer.destroy();
});

afterAll(() => {
  server?.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

const mounted: TestRendererSetup[] = [];

/**
 * The built-in waitForFrame gives up the moment no render is scheduled, so it
 * cannot wait on anything driven by the network. This yields to the event loop
 * instead, letting fetches settle and React re-render.
 */
async function until(
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  timeoutMs = 25_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = setup.captureCharFrame();
  while (Date.now() < deadline) {
    if (predicate(frame)) return frame;
    await Bun.sleep(15);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
  }
  throw new Error(`timed out waiting for frame:\n${frame}`);
}

/** Lets React commit pending state before the next simulated keypress. */
async function settle(setup: TestRendererSetup): Promise<void> {
  await Bun.sleep(50);
  await setup.renderOnce();
}

async function mount(): Promise<TestRendererSetup> {
  const setup = await testRender(<App api={api} onQuit={() => {}} />, { width: 130, height: 42 });
  mounted.push(setup);
  await until(setup, (frame) => frame.includes("Shop MySQL"));
  return setup;
}

describe("TUI", () => {
  test("renders the target list with live data from the engine", async () => {
    const setup = await mount();
    const { captureCharFrame } = setup;
    const frame = captureCharFrame();
    expect(frame).toContain("backupbot");
    expect(frame).toContain("targets (1)");
    expect(frame).toContain("Shop MySQL");
    expect(frame).toContain("mysql");
    expect(frame).toContain("0 3 * * *");
    expect(frame).toContain("Europe/Madrid"); // in the detail panel
    expect(frame).toContain("never"); // no runs yet
  });

  test("never shows the password, only a masked connection string", async () => {
    const setup = await mount();
    const { captureCharFrame } = setup;
    const frame = captureCharFrame();
    expect(frame).not.toContain("rootpw");
    expect(frame).toContain("mysql://root:****@127.0.0.1:53306/shop");
  });

  test("a opens the add form and esc returns to the list", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressKey("a");
    await until(setup, (frame) => frame.includes("add target"));
    const form = captureCharFrame();
    expect(form).toContain("Connection");
    expect(form).toContain("Retention");
    expect(form).toContain("^t test connection");

    mockInput.pressEscape();
    await until(setup, (frame) => frame.includes("targets (1)"));
    expect(captureCharFrame()).toContain("Shop MySQL");
  });

  test("the form previews the next run and rejects a bad cron expression", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressKey("a");
    await until(setup, (frame) => frame.includes("add target"));
    // Default schedule is valid, so a concrete timestamp is previewed.
    expect(captureCharFrame()).toMatch(/next run\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);

    // Tab to the schedule field. Focus moves on the next React render, so wait
    // for the indicator before typing — otherwise the text lands in Name.
    mockInput.pressTab();
    mockInput.pressTab();
    await until(setup, (frame) => frame.includes("▸ Schedule"));
    await mockInput.typeText("nope");
    await until(setup, (frame) => frame.includes("invalid cron expression"));
    expect(captureCharFrame()).toContain("invalid cron expression");
  }, 60_000);

  test.skipIf(!MYSQL_UP)("^t reports connection warnings from a real server", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressKey("a");
    await until(setup, (frame) => frame.includes("add target"));
    mockInput.pressTab(); // Name -> Connection
    await until(setup, (frame) => frame.includes("▸ Connection"));
    await mockInput.typeText(MYSQL_DSN);
    await settle(setup);
    mockInput.pressKey("t", { ctrl: true });

    await until(setup, (frame) => frame.includes("● connected") || frame.includes("✕ failed"));
    const frame = captureCharFrame();
    expect(frame).toContain("● connected");
    expect(frame).toContain("server 8.");
    // The field you are typing into shows the DSN by design — you need to see
    // it to fix a typo. Masking applies wherever a stored DSN is shown back,
    // which the list, detail and log assertions cover.
  }, 60_000);

  test("d asks before deleting and n keeps the target", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressKey("d");
    await until(setup, (frame) => frame.includes("delete target"));
    expect(captureCharFrame()).toContain('Delete "Shop MySQL"?');
    expect(captureCharFrame()).toContain("stay on disk");

    mockInput.pressKey("n");
    await until(setup, (frame) => frame.includes("targets (1)"));
    expect(ctx.store.listTargets()).toHaveLength(1);
  });

  test("enter opens run history for the selected target", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressEnter();
    await until(setup, (frame) => frame.includes("stored backups"));
    const frame = captureCharFrame();
    expect(frame).toContain("runs · Shop MySQL");
    expect(frame).toContain("No runs yet");

    mockInput.pressEscape();
    await until(setup, (frame) => frame.includes("targets (1)"));
  });

  test.skipIf(!MYSQL_UP)("r runs a real backup and streams the log to completion", async () => {
    const setup = await mount();
    const { mockInput, captureCharFrame } = setup;

    mockInput.pressKey("r");
    // Wait for the final result panel, not just the log line that precedes it.
    await until(setup, (frame) => frame.includes("SUCCESS"));

    const frame = captureCharFrame();
    expect(frame).toContain("verify passed");
    expect(frame).toContain("2 tables");
    expect(frame).toContain("SUCCESS");
    expect(frame).not.toContain("rootpw");

    // The engine really wrote an artifact, not just log lines.
    const artifacts = ctx.store.listArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.sizeBytes).toBeGreaterThan(0);
    expect(await Bun.file(artifacts[0]!.path).exists()).toBe(true);
  }, 60_000);
});
