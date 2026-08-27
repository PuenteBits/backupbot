import type { Engine } from "./schema";

export interface ParsedDsn {
  engine: Engine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  params: Record<string, string>;
}

const DEFAULT_PORTS: Record<Engine, number> = { postgres: 5432, mysql: 3306 };

const SCHEMES: Record<string, Engine> = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
  "mariadb:": "mysql",
};

export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    throw new Error("connection string is not a valid URL (percent-encode any @ : / ? # in the password)");
  }
  const engine = SCHEMES[url.protocol];
  if (!engine) throw new Error(`unsupported scheme ${url.protocol.replace(":", "")}`);

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("connection string is missing a database name");

  return {
    engine,
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORTS[engine],
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    params: Object.fromEntries(url.searchParams),
  };
}

/** `postgres://user:****@host:5432/db` — safe for logs, API responses and the TUI. */
export function maskDsn(dsn: string): string {
  try {
    const url = new URL(dsn.trim());
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return "****";
  }
}

export interface DsnWarning {
  level: "error" | "warn";
  message: string;
}

/**
 * Catches the connection mistakes that only surface as a confusing failure
 * hours later, at 3am, on a schedule nobody is watching.
 */
export function inspectDsn(parsed: ParsedDsn): DsnWarning[] {
  const warnings: DsnWarning[] = [];
  const { host, port, engine } = parsed;

  if (engine === "postgres" && host.endsWith(".pooler.supabase.com") && port === 6543) {
    warnings.push({
      level: "error",
      message:
        "Port 6543 is Supabase's transaction pooler, which cannot serve pg_dump. Use the session pooler on port 5432.",
    });
  }
  if (engine === "postgres" && /^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    warnings.push({
      level: "warn",
      message:
        "Supabase direct connections are IPv6-only without the IPv4 add-on. If your network is IPv4-only, use the session pooler host instead.",
    });
  }
  if (!parsed.password) {
    warnings.push({ level: "warn", message: "No password in the connection string." });
  }
  if (engine === "postgres" && !parsed.params.sslmode && !isLocal(host)) {
    warnings.push({
      level: "warn",
      message: "No sslmode set for a remote host; defaulting to sslmode=require.",
    });
  }
  return warnings;
}

export function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}
