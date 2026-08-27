import { randomUUID } from "node:crypto";
import { exec, execOrThrow, which } from "./exec";
import type { JobContext, VerifyReport } from "./types";

export interface RestoreSpec {
  image: string;
  env: Record<string, string>;
  /** Run inside the container until it exits 0 — then the server is really up. */
  readyCommand: string[];
  restore: (container: string) => Promise<void>;
  /** Number of user tables visible after the restore. */
  count: (container: string) => Promise<number>;
}

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 2_000;

/**
 * The strongest check available: restore the artifact into a throwaway
 * database and confirm tables actually land. Requires access to the Docker
 * socket, which is effectively root on the host — hence opt-in per target
 * and gated behind BACKUPBOT_ALLOW_DOCKER.
 */
export async function verifyByRestore(ctx: JobContext, spec: RestoreSpec): Promise<VerifyReport> {
  if (process.env.BACKUPBOT_ALLOW_DOCKER !== "1") {
    return {
      mode: "restore",
      ok: false,
      detail: "restore verification requires BACKUPBOT_ALLOW_DOCKER=1 and a mounted Docker socket",
    };
  }
  if (!(await which("docker"))) {
    return { mode: "restore", ok: false, detail: "docker CLI not available inside the engine" };
  }

  const container = `backupbot-verify-${randomUUID().slice(0, 8)}`;
  const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  try {
    ctx.log(`starting throwaway ${spec.image} as ${container}`);
    await execOrThrow(["docker", "run", "-d", "--name", container, ...envArgs, spec.image], {
      redact: ctx.redact,
      signal: ctx.signal,
    });

    await waitForReady(container, spec.readyCommand, ctx);
    ctx.log("restoring into the throwaway database");
    await spec.restore(container);

    const tables = await spec.count(container);
    return {
      mode: "restore",
      ok: tables > 0,
      objectCount: tables,
      detail: tables > 0 ? `restored cleanly: ${tables} user tables present` : "restore produced no user tables",
    };
  } catch (err) {
    return { mode: "restore", ok: false, detail: (err as Error).message };
  } finally {
    // Never leave a container behind, even when the run was aborted.
    await exec(["docker", "rm", "-f", container]).catch(() => {});
  }
}

async function waitForReady(container: string, readyCommand: string[], ctx: JobContext): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new Error("cancelled while waiting for the verification database");
    const probe = await exec(["docker", "exec", container, ...readyCommand]);
    if (probe.code === 0) return;
    await Bun.sleep(READY_POLL_MS);
  }
  throw new Error(`verification database did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}
