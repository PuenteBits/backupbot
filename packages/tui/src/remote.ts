#!/usr/bin/env bun
/**
 * Runs the TUI against a NAS over a tunnel that lives exactly as long as the
 * TUI does.
 *
 * The engine binds to loopback on the NAS, so reaching it from a laptop needs a
 * forward. Leaving one running is the problem this avoids: a forgotten tunnel
 * is invisible until months later, when something breaks and nobody remembers
 * it exists. So the tunnel is a child process, on an ephemeral port, torn down
 * on every exit path — clean quit, ctrl-c, kill, or crash.
 *
 * The token is read from the NAS at startup and passed to the TUI in its
 * environment, so no copy of it is written to this machine either.
 */
import { createServer } from "node:net";

export interface RemoteOptions {
  host: string;
  remotePort: number;
  remoteDb: string;
  token: string | null;
}

const DEFAULT_DB = "/volume1/docker/backupbot/data/backupbot.sqlite";

/** Pure so the resolution order is testable without an SSH server. */
export function resolveRemoteOptions(argv: string[], env: Record<string, string | undefined>): RemoteOptions {
  const host = argv[0] ?? env.BACKUPBOT_SSH_HOST;
  if (!host) {
    throw new Error(
      "No SSH host. Usage: bun run tui:remote <ssh-host>, or set BACKUPBOT_SSH_HOST.\n" +
        "The host is whatever you type after `ssh` — an ~/.ssh/config alias is fine.",
    );
  }
  return {
    host,
    remotePort: Number(env.BACKUPBOT_REMOTE_PORT ?? 7817),
    remoteDb: env.BACKUPBOT_REMOTE_DB ?? DEFAULT_DB,
    token: env.BACKUPBOT_TOKEN ?? null,
  };
}

/** An unused local port, so two sessions never collide and nothing is predictable. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("could not find a free port"))));
    });
  });
}

async function fetchToken(options: RemoteOptions): Promise<string> {
  const query = `SELECT value FROM settings WHERE key='api.token';`;
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", options.host, `sqlite3 -readonly ${options.remoteDb} "${query}"`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const token = out.trim();
  if (code !== 0 || !token) {
    throw new Error(
      `Could not read the API token from ${options.host}:${options.remoteDb}.\n` +
        `${err.trim() || "no output"}\n` +
        "Set BACKUPBOT_REMOTE_DB if the engine's data directory is elsewhere, or BACKUPBOT_TOKEN to skip this step.",
    );
  }
  return token;
}

/** Resolves once the engine answers through the forward, or throws. */
async function waitForEngine(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await Bun.sleep(200);
  }
  throw new Error(`The tunnel came up but the engine never answered (${lastError}).`);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const options = resolveRemoteOptions(argv, env);
  const token = options.token ?? (await fetchToken(options));
  const localPort = await freePort();
  const url = `http://127.0.0.1:${localPort}`;

  const tunnel = Bun.spawn(
    [
      "ssh",
      "-o", "BatchMode=yes",
      // Fail loudly instead of sitting there with a forward that never bound.
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-L", `${localPort}:127.0.0.1:${options.remotePort}`,
      options.host,
      // A remote `cat` rather than -N, so the tunnel dies with this process even
      // when no handler gets to run: SIGKILL closes our end of its stdin, the
      // remote cat reads EOF, and ssh exits. With -N, ssh ignores stdin and a
      // kill -9 here would strand the forward — measurably: -N orphans, cat does not.
      "cat",
    ],
    // stdin is a pipe we hold open, never inherited — ssh and the TUI would
    // otherwise fight over the same keystrokes.
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );

  let closed = false;
  const closeTunnel = () => {
    if (closed) return;
    closed = true;
    try {
      tunnel.kill();
    } catch {
      /* already gone */
    }
  };
  // Every exit path, including the ones that skip finally blocks.
  process.on("exit", closeTunnel);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      closeTunnel();
      process.exit(130);
    });
  }

  try {
    await waitForEngine(url);
  } catch (err) {
    closeTunnel();
    const stderr = (await new Response(tunnel.stderr).text()).trim();
    console.error(`${(err as Error).message}`);
    if (stderr) console.error(stderr);
    if (/administratively prohibited/.test(stderr)) {
      console.error(
        "\nThe NAS is refusing port forwarding. On DSM, set AllowTcpForwarding yes in\n" +
          "/etc/ssh/sshd_config and run: sudo synosystemctl restart sshd",
      );
    }
    return 1;
  }

  // The TUI runs in this process rather than a child. A child would inherit the
  // tunnel's stdin pipe and hold it open after a kill -9 here, stranding the
  // very forward this is trying not to leak — and would be a second stray of its
  // own. Importing it means process.exit from the TUI still runs our exit hook.
  process.env.BACKUPBOT_URL = url;
  process.env.BACKUPBOT_TOKEN = token;
  await import("./index.tsx");

  // index.tsx owns the terminal and exits the process itself.
  return await new Promise<number>(() => {});
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2), process.env));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
