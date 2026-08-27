import { unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isLocal, type ParsedDsn } from "@backupbot/core";
import { execOrThrow } from "../exec";
import { mysqlClientBinary, mysqlDumpBinary, pickCompressor } from "../tools";
import { verifyByRestore } from "../verify-restore";
import type { Adapter, ConnectionCheck, DumpResult, JobContext, Redactor, VerifyReport } from "../types";

export const SSL_MODES = ["DISABLED", "PREFERRED", "REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"] as const;

/**
 * TLS settings for the defaults file.
 *
 * The MariaDB client has no `ssl-mode` — it has `ssl` and
 * `ssl-verify-server-cert` — and since 11.4 it verifies certificates by
 * default. Managed MySQL reached through a proxy (Railway, PlanetScale)
 * presents a self-signed certificate, so the default fails with
 * "self-signed certificate in certificate chain" before a backup can run.
 *
 * So we accept the portable `ssl-mode` spelling that providers and MySQL's own
 * client use, and translate it. Absent one, a remote host gets REQUIRED —
 * encrypted, certificate not verified — matching what the Postgres adapter
 * already defaults to with `sslmode=require`.
 */
export function sslSettings(dsn: ParsedDsn): string[] {
  const requested = (dsn.params["ssl-mode"] ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (requested && !(SSL_MODES as readonly string[]).includes(requested)) {
    throw new Error(`unknown ssl-mode "${dsn.params["ssl-mode"]}" — expected one of ${SSL_MODES.join(", ")}`);
  }
  const mode = requested || (isLocal(dsn.host) ? "PREFERRED" : "REQUIRED");

  const lines: string[] = [];
  switch (mode) {
    case "DISABLED":
      lines.push("ssl=0");
      break;
    case "PREFERRED":
      // Encrypt if the server offers it, and never fail on the certificate.
      lines.push("ssl-verify-server-cert=0");
      break;
    case "REQUIRED":
      lines.push("ssl=1", "ssl-verify-server-cert=0");
      break;
    case "VERIFY_CA":
    case "VERIFY_IDENTITY":
      // Only reachable when asked for explicitly, and only workable with a CA.
      lines.push("ssl=1", "ssl-verify-server-cert=1");
      break;
  }
  if (dsn.params["ssl-ca"]) lines.push(`ssl-ca=${dsn.params["ssl-ca"]}`);
  return lines;
}

/**
 * MySQL clients warn (or refuse) when a password is passed on the command
 * line, and argv is world-readable anyway — so credentials go through a
 * 0600 defaults file that is deleted as soon as the process exits.
 */
async function withDefaultsFile<T>(dsn: ParsedDsn, fn: (path: string) => Promise<T>): Promise<T> {
  const path = `${tmpdir()}/backupbot-${randomUUID()}.cnf`;
  const lines = [
    "[client]",
    `host=${dsn.host}`,
    `port=${dsn.port}`,
    `user=${dsn.user}`,
    `password=${dsn.password}`,
  ];
  lines.push(...sslSettings(dsn));
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

async function serverVersion(dsn: ParsedDsn, redact: Redactor): Promise<{ text: string; isMaria: boolean }> {
  const client = await mysqlClientBinary();
  return withDefaultsFile(dsn, async (cnf) => {
    const result = await execOrThrow([client, `--defaults-extra-file=${cnf}`, "-N", "-B", "-e", "SELECT VERSION()"], {
      redact,
    });
    const text = result.stdout.trim();
    return { text, isMaria: /mariadb/i.test(text) };
  });
}

export const mysqlAdapter: Adapter = {
  engine: "mysql",

  async extension() {
    return `.sql${(await pickCompressor()).extension}`;
  },

  async testConnection(dsn, redact): Promise<ConnectionCheck> {
    try {
      const version = await serverVersion(dsn, redact);
      return {
        ok: true,
        serverVersion: version.text,
        serverMajor: Number(version.text.match(/^(\d+)/)?.[1] ?? 0),
        client: await mysqlDumpBinary(),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async dump(ctx: JobContext): Promise<DumpResult> {
    const version = await serverVersion(ctx.dsn, ctx.redact);
    const dumpBin = await mysqlDumpBinary();
    const compressor = await pickCompressor();
    ctx.log(`server ${version.text}; using ${dumpBin} piped through ${compressor.command("out")[0]}`);

    await withDefaultsFile(ctx.dsn, async (cnf) => {
      const args = [
        dumpBin,
        `--defaults-extra-file=${cnf}`,
        "--single-transaction", // consistent snapshot without locking InnoDB tables
        "--quick",
        "--routines",
        "--triggers",
        "--events",
        "--no-tablespaces", // managed providers rarely grant the PROCESS privilege
        "--default-character-set=utf8mb4",
      ];
      // GTID metadata makes a dump un-restorable onto a fresh server; MariaDB has no such flag.
      if (!version.isMaria) args.push("--set-gtid-purged=OFF");
      args.push(ctx.dsn.database);

      const dump = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: ctx.signal });
      const compress = Bun.spawn(compressor.command(ctx.outPath), {
        stdin: dump.stdout,
        stdout: "ignore",
        stderr: "pipe",
        signal: ctx.signal,
      });

      const [dumpErr, compressErr] = await Promise.all([
        new Response(dump.stderr).text(),
        new Response(compress.stderr).text(),
      ]);
      const [dumpCode, compressCode] = await Promise.all([dump.exited, compress.exited]);

      for (const line of ctx.redact(dumpErr).split("\n")) if (line.trim()) ctx.log(line);
      if (dumpCode !== 0) throw new Error(`mysqldump exited with code ${dumpCode}: ${ctx.redact(dumpErr).trim()}`);
      if (compressCode !== 0) throw new Error(`compression exited with code ${compressCode}: ${compressErr.trim()}`);
    });

    return { format: `mysql_sql${compressor.extension}`, notes: { serverVersion: version.text } };
  },

  async verifyArchive(ctx: JobContext): Promise<VerifyReport> {
    const compressor = await pickCompressor();
    const proc = Bun.spawn(compressor.decompress(ctx.outPath), { stdout: "pipe", stderr: "pipe" });

    // Stream rather than buffer — these dumps get large. Counting happens only
    // on whole lines, so a statement split across chunks is neither missed nor
    // counted twice.
    let tables = 0;
    let pending = "";
    let tail = "";
    const decoder = new TextDecoder();
    const countIn = (text: string) => (text.match(/^CREATE TABLE /gm) ?? []).length;

    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-400);
      pending += text;
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) continue;
      tables += countIn(pending.slice(0, lastNewline + 1));
      pending = pending.slice(lastNewline + 1);
    }
    tables += countIn(pending);

    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;

    if (code !== 0) {
      return { mode: "archive", ok: false, detail: `decompression failed: ${stderr.trim().split("\n").at(-1)}` };
    }
    // mysqldump writes this only after it has flushed everything successfully.
    const complete = /Dump completed/.test(tail);
    if (!complete) {
      return {
        mode: "archive",
        ok: false,
        objectCount: tables,
        detail: "archive is missing mysqldump's completion marker — it was likely truncated",
      };
    }
    if (tables === 0) {
      // Nearly always the wrong database name or a user without SELECT on it,
      // rather than a database that is genuinely empty.
      return {
        mode: "archive",
        ok: false,
        objectCount: 0,
        detail: `the dump of "${ctx.dsn.database}" contains no tables — check the database name and the user's privileges`,
      };
    }
    return {
      mode: "archive",
      ok: true,
      objectCount: tables,
      detail: `archive decompresses cleanly, ${tables} tables, dump marked complete`,
    };
  },

  async verifyRestore(ctx: JobContext): Promise<VerifyReport> {
    const version = await serverVersion(ctx.dsn, ctx.redact);
    const image = version.isMaria ? "mariadb:11" : "mysql:8";
    const compressor = await pickCompressor();
    return verifyByRestore(ctx, {
      image,
      env: { MYSQL_ROOT_PASSWORD: "verify", MYSQL_DATABASE: "verify" },
      // `mysqladmin ping` reports success during the entrypoint's init phase,
      // while auth still fails — so probe with a query that must authenticate.
      readyCommand: ["sh", "-c", "MYSQL_PWD=verify mysql -uroot -N -B -e 'SELECT 1' verify"],
      restore: async (container) => {
        const decompress = Bun.spawn(compressor.decompress(ctx.outPath), { stdout: "pipe", stderr: "pipe" });
        await execOrThrow(
          ["docker", "exec", "-i", container, "sh", "-c", "MYSQL_PWD=verify mysql -uroot verify"],
          { stdin: decompress.stdout, redact: ctx.redact, signal: ctx.signal, onLine: ctx.log },
        );
      },
      count: async (container) => {
        const result = await execOrThrow(
          ["docker", "exec", container, "sh", "-c",
            "MYSQL_PWD=verify mysql -uroot -N -B -e \"SELECT count(*) FROM information_schema.tables WHERE table_schema='verify'\""],
          { redact: ctx.redact },
        );
        return Number(result.stdout.trim());
      },
    });
  },

  restoreHint(artifactPath: string): string {
    return `zstd -dc ${JSON.stringify(artifactPath)} | mysql -h HOST -P PORT -u USER -p DATABASE`;
  },
};
