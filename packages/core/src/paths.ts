import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every path is overridable by env so the Docker image can point at mounted
 * volumes without the code caring where they are.
 */
export interface Paths {
  dataDir: string;
  backupsDir: string;
  logsDir: string;
  dbFile: string;
  keyFile: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const dataDir = resolve(env.BACKUPBOT_DATA_DIR ?? "./data");
  const backupsDir = resolve(env.BACKUPBOT_BACKUPS_DIR ?? "./backups");
  return {
    dataDir,
    backupsDir,
    logsDir: resolve(env.BACKUPBOT_LOGS_DIR ?? `${dataDir}/logs`),
    dbFile: resolve(env.BACKUPBOT_DB_FILE ?? `${dataDir}/backupbot.sqlite`),
    keyFile: resolve(env.BACKUPBOT_KEY_FILE ?? `${dataDir}/master.key`),
  };
}

export function ensurePaths(paths: Paths): Paths {
  for (const dir of [paths.dataDir, paths.backupsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}
