import { existsSync, readdirSync } from "node:fs";
import { exec, which } from "./exec";

/**
 * pg_dump refuses to dump from a server newer than itself, so the image ships
 * several client versions and we pick per-target at run time. Debian installs
 * them side by side under /usr/lib/postgresql/<major>/bin.
 */
const PG_LIB_DIRS = ["/usr/lib/postgresql", "/usr/pgsql", "/opt/homebrew/opt", "/usr/local/opt"];

export interface PgClient {
  major: number;
  binDir: string;
}

let pgClientCache: PgClient[] | null = null;

export async function discoverPgClients(refresh = false): Promise<PgClient[]> {
  if (pgClientCache && !refresh) return pgClientCache;
  const found = new Map<number, string>();

  for (const root of PG_LIB_DIRS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      // Matches both "17" (Debian) and "postgresql@17" (Homebrew).
      const major = Number(entry.match(/(\d+)$/)?.[1]);
      if (!Number.isFinite(major)) continue;
      const binDir = `${root}/${entry}/bin`;
      if (existsSync(`${binDir}/pg_dump`) && !found.has(major)) found.set(major, binDir);
    }
  }

  // Whatever is on PATH counts too — covers dev machines and slim images.
  const onPath = await which("pg_dump");
  if (onPath) {
    const version = await exec([onPath, "--version"]);
    const major = Number(version.stdout.match(/(\d+)/)?.[1]);
    if (Number.isFinite(major) && !found.has(major)) {
      found.set(major, onPath.replace(/\/pg_dump$/, ""));
    }
  }

  pgClientCache = [...found.entries()]
    .map(([major, binDir]) => ({ major, binDir }))
    .sort((a, b) => a.major - b.major);
  return pgClientCache;
}

export class NoCompatibleClientError extends Error {
  constructor(serverMajor: number, available: number[]) {
    super(
      available.length === 0
        ? "No PostgreSQL client tools found. Install postgresql-client, or run the engine in the backupbot container."
        : `Server is PostgreSQL ${serverMajor} but the newest available client is ${Math.max(...available)}. ` +
            `pg_dump cannot dump from a newer server — install postgresql-client-${serverMajor}.`,
    );
    this.name = "NoCompatibleClientError";
  }
}

/** The oldest client that is still >= the server major, matching exactly when possible. */
export async function pgClientFor(serverMajor: number): Promise<PgClient> {
  const clients = await discoverPgClients();
  const compatible = clients.filter((c) => c.major >= serverMajor);
  const chosen = compatible[0];
  if (!chosen) throw new NoCompatibleClientError(serverMajor, clients.map((c) => c.major));
  return chosen;
}

/** Newest client available; psql connects to any server so version hardly matters. */
export async function newestPgClient(): Promise<PgClient> {
  const clients = await discoverPgClients();
  const newest = clients.at(-1);
  if (!newest) throw new NoCompatibleClientError(0, []);
  return newest;
}

export interface Compressor {
  /** Command reading stdin and writing the named file. */
  command: (outPath: string) => string[];
  /** Command writing the decompressed stream to stdout. */
  decompress: (inPath: string) => string[];
  extension: string;
}

let compressorCache: Compressor | null = null;

export async function pickCompressor(): Promise<Compressor> {
  if (compressorCache) return compressorCache;
  if (await which("zstd")) {
    compressorCache = {
      command: (out) => ["zstd", "-T0", "-3", "-q", "-o", out],
      decompress: (input) => ["zstd", "-dc", input],
      extension: ".zst",
    };
  } else {
    compressorCache = {
      command: (out) => ["sh", "-c", `gzip -6 -c > ${JSON.stringify(out)}`],
      decompress: (input) => ["gzip", "-dc", input],
      extension: ".gz",
    };
  }
  return compressorCache;
}

const dumpOptionCache = new Map<string, boolean>();

/**
 * Whether a dump binary understands an option.
 *
 * mariadb-dump and Oracle's mysqldump have diverged, and an option the binary
 * does not know is a hard failure — "unknown variable", exit 7 — not a warning.
 * Crucially it is the *client* that decides this, not the server: dumping a
 * MySQL server with mariadb-dump still means no --set-gtid-purged.
 */
export async function dumpSupportsOption(bin: string, option: string): Promise<boolean> {
  const key = `${bin}\u0000${option}`;
  const cached = dumpOptionCache.get(key);
  if (cached !== undefined) return cached;
  const help = await exec([bin, "--help"]);
  // Not \b: a hyphen counts as a word boundary, so --set-gtid would match
  // --set-gtid-purged and report an option the binary does not have.
  const supported = new RegExp(`--${option}(?![\\w-])`).test(`${help.stdout}\n${help.stderr}`);
  dumpOptionCache.set(key, supported);
  return supported;
}

export async function mysqlDumpBinary(): Promise<string> {
  // MariaDB renamed the tools; either connects to either server, but their
  // option sets differ — see dumpSupportsOption.
  for (const bin of ["mariadb-dump", "mysqldump"]) {
    const path = await which(bin);
    if (path) return path;
  }
  throw new Error("No mysqldump/mariadb-dump found. Install mariadb-client, or use the backupbot container.");
}

export async function mysqlClientBinary(): Promise<string> {
  for (const bin of ["mariadb", "mysql"]) {
    const path = await which(bin);
    if (path) return path;
  }
  throw new Error("No mysql/mariadb client found. Install mariadb-client, or use the backupbot container.");
}
