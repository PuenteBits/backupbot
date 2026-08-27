import type { ParsedDsn } from "@backupbot/core";
import { isLocal } from "@backupbot/core";
import { exec, execOrThrow } from "../exec";
import { newestPgClient, pgClientFor } from "../tools";
import { verifyByRestore } from "../verify-restore";
import type { Adapter, ConnectionCheck, DumpResult, JobContext, Redactor, VerifyReport } from "../types";

/**
 * libpq keyword/value form rather than a URL: it sidesteps every
 * percent-encoding trap that passwords with punctuation create.
 */
function conninfo(dsn: ParsedDsn, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    host: dsn.host,
    port: String(dsn.port),
    user: dsn.user,
    dbname: dsn.database,
    sslmode: dsn.params.sslmode ?? (isLocal(dsn.host) ? "prefer" : "require"),
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}='${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
    .join(" ");
}

/** The password never appears in argv, where `ps` would expose it. */
function pgEnv(dsn: ParsedDsn): Record<string, string> {
  return { PGPASSWORD: dsn.password, PGCONNECT_TIMEOUT: "15" };
}

async function serverVersion(dsn: ParsedDsn, redact: Redactor): Promise<{ text: string; major: number }> {
  const { binDir } = await newestPgClient();
  const result = await execOrThrow(
    [`${binDir}/psql`, "--no-psqlrc", "-tAc", "SELECT current_setting('server_version_num')", conninfo(dsn)],
    { env: pgEnv(dsn), redact },
  );
  const num = Number(result.stdout.trim());
  if (!Number.isFinite(num)) throw new Error(`could not read server version (got ${JSON.stringify(result.stdout)})`);
  // 170004 -> 17, and pre-10 encodings like 90624 -> 9.
  return { text: num >= 100000 ? String(Math.floor(num / 10000)) : `${Math.floor(num / 10000)}.${Math.floor((num % 10000) / 100)}`, major: Math.floor(num / 10000) };
}

export const postgresAdapter: Adapter = {
  engine: "postgres",

  async extension() {
    // Custom format is already compressed and supports selective pg_restore.
    return ".dump";
  },

  async testConnection(dsn, redact): Promise<ConnectionCheck> {
    try {
      const version = await serverVersion(dsn, redact);
      const client = await pgClientFor(version.major);
      return {
        ok: true,
        serverVersion: version.text,
        serverMajor: version.major,
        client: `${client.binDir}/pg_dump (v${client.major})`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async dump(ctx: JobContext): Promise<DumpResult> {
    const version = await serverVersion(ctx.dsn, ctx.redact);
    const client = await pgClientFor(version.major);
    ctx.log(`server PostgreSQL ${version.text}; using pg_dump v${client.major} from ${client.binDir}`);

    await execOrThrow(
      [
        `${client.binDir}/pg_dump`,
        "--format=custom",
        "--no-password",
        "--verbose",
        `--file=${ctx.outPath}`,
        conninfo(ctx.dsn),
      ],
      {
        env: pgEnv(ctx.dsn),
        redact: ctx.redact,
        signal: ctx.signal,
        onLine: (line) => ctx.log(line),
      },
    );

    return { format: "pg_custom", notes: { serverVersion: version.text, client: `pg_dump ${client.major}` } };
  },

  async verifyArchive(ctx: JobContext): Promise<VerifyReport> {
    const { binDir } = await newestPgClient();
    // Parsing the table of contents proves the archive is complete and readable.
    const result = await exec([`${binDir}/pg_restore`, "--list", ctx.outPath], { redact: ctx.redact });
    if (result.code !== 0) {
      return { mode: "archive", ok: false, detail: result.stderr.trim().split("\n").slice(-3).join("; ") };
    }
    const entries = result.stdout.split("\n").filter((l) => l.trim() && !l.startsWith(";"));
    const tables = entries.filter((l) => / TABLE DATA /.test(l)).length;
    return {
      mode: "archive",
      ok: entries.length > 0,
      objectCount: entries.length,
      detail: entries.length > 0
        ? `table of contents readable: ${entries.length} objects, ${tables} tables with data`
        : "archive contains no objects",
    };
  },

  async verifyRestore(ctx: JobContext): Promise<VerifyReport> {
    const version = await serverVersion(ctx.dsn, ctx.redact);
    return verifyByRestore(ctx, {
      image: `postgres:${version.major}-alpine`,
      env: { POSTGRES_PASSWORD: "verify", POSTGRES_DB: "verify" },
      // pg_isready goes green during the entrypoint's init phase; a real query
      // against the target database is the honest readiness signal.
      readyCommand: ["psql", "-U", "postgres", "-d", "verify", "-tAqc", "SELECT 1"],
      restore: async (container) => {
        await execOrThrow(
          ["docker", "exec", "-i", container, "pg_restore", "--no-owner", "--no-privileges", "--exit-on-error", "-U", "postgres", "-d", "verify"],
          { stdin: Bun.file(ctx.outPath), redact: ctx.redact, signal: ctx.signal, onLine: ctx.log },
        );
      },
      count: async (container) => {
        const result = await execOrThrow(
          ["docker", "exec", container, "psql", "-tAqc", "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')", "-U", "postgres", "-d", "verify"],
          { redact: ctx.redact },
        );
        return Number(result.stdout.trim());
      },
    });
  },

  restoreHint(artifactPath: string): string {
    return `pg_restore --clean --if-exists --no-owner --no-privileges -d "$TARGET_DSN" ${JSON.stringify(artifactPath)}`;
  },
};
