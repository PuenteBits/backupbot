import { Database } from "bun:sqlite";

/**
 * Migrations are append-only: add a new statement to the end, never edit an
 * existing one. `user_version` tracks how many have been applied.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE targets (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT    NOT NULL,
     slug       TEXT    NOT NULL UNIQUE,
     engine     TEXT    NOT NULL,
     dsn_enc    TEXT    NOT NULL,
     schedule   TEXT    NOT NULL,
     timezone   TEXT    NOT NULL DEFAULT 'UTC',
     retention  TEXT    NOT NULL,
     verify     TEXT    NOT NULL DEFAULT 'archive',
     enabled    INTEGER NOT NULL DEFAULT 1,
     created_at TEXT    NOT NULL,
     updated_at TEXT    NOT NULL
   );

   CREATE TABLE runs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
     status      TEXT    NOT NULL,
     trigger     TEXT    NOT NULL,
     started_at  TEXT    NOT NULL,
     finished_at TEXT,
     duration_ms INTEGER,
     bytes       INTEGER,
     error       TEXT,
     log_path    TEXT
   );
   CREATE INDEX idx_runs_target_started ON runs(target_id, started_at DESC);

   CREATE TABLE artifacts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     target_id  INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
     path       TEXT    NOT NULL UNIQUE,
     size_bytes INTEGER NOT NULL,
     sha256     TEXT    NOT NULL,
     format     TEXT    NOT NULL,
     created_at TEXT    NOT NULL
   );
   CREATE INDEX idx_artifacts_target_created ON artifacts(target_id, created_at DESC);

   CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  `CREATE TABLE channels (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT    NOT NULL,
     kind         TEXT    NOT NULL,
     -- The whole config blob is encrypted: a webhook URL is a credential.
     config_enc   TEXT    NOT NULL,
     events       TEXT    NOT NULL,
     -- JSON array of target slugs, or NULL for "every target".
     targets      TEXT,
     enabled      INTEGER NOT NULL DEFAULT 1,
     last_sent_at TEXT,
     last_error   TEXT,
     created_at   TEXT    NOT NULL,
     updated_at   TEXT    NOT NULL
   );`,
];

export function openDatabase(dbFile: string): Database {
  const db = new Database(dbFile, { create: true });
  // WAL lets the CLI read history while the daemon is mid-backup.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

export function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
