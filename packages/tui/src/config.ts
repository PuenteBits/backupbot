import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface TuiConfig {
  url: string;
  token: string;
  /** Where the token came from, so the error screen can suggest a fix. */
  source: string;
}

const CONFIG_FILE = `${homedir()}/.config/backupbot/tui.json`;

/**
 * Token resolution, in order: environment, config file, then the engine's own
 * SQLite settings — that last one makes the TUI work with no setup at all when
 * it runs on the NAS alongside the daemon.
 */
export function loadConfig(env = process.env): TuiConfig {
  const url = env.BACKUPBOT_URL ?? "http://127.0.0.1:7817";

  if (env.BACKUPBOT_TOKEN) return { url, token: env.BACKUPBOT_TOKEN, source: "BACKUPBOT_TOKEN" };

  if (existsSync(CONFIG_FILE)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<TuiConfig>;
      if (file.token) return { url: file.url ?? url, token: file.token, source: CONFIG_FILE };
    } catch {
      /* fall through to the local database */
    }
  }

  const local = tokenFromLocalDatabase(env);
  if (local) return { url, token: local, source: "local engine database" };

  throw new Error(
    `No API token found. Set BACKUPBOT_TOKEN, or write {"url":"…","token":"…"} to ${CONFIG_FILE}.\n` +
      `Get the token with: docker exec backupbot bun run /app/packages/cli/src/index.ts token`,
  );
}

function tokenFromLocalDatabase(env: NodeJS.ProcessEnv): string | null {
  try {
    // Imported lazily: on a laptop there is no local database and no key.
    const { createContext, getSetting } = require("@backupbot/core") as typeof import("@backupbot/core");
    const dataDir = env.BACKUPBOT_DATA_DIR ?? "./data";
    if (!existsSync(dataDir)) return null;
    return getSetting(createContext(env).store.db, "api.token");
  } catch {
    return null;
  }
}
