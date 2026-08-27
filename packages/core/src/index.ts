export * from "./schema";
export * from "./paths";
export * from "./crypto";
export * from "./dsn";
export * from "./redact";
export * from "./db";
export * from "./store";
export * from "./schedule";
export * from "./format";

import { loadOrCreateKey, SecretBox } from "./crypto";
import { openDatabase } from "./db";
import { ensurePaths, resolvePaths, type Paths } from "./paths";
import { Store } from "./store";

export interface Context {
  paths: Paths;
  store: Store;
}

/** One call to get a fully wired store: directories, key, database, migrations. */
export function createContext(env: Record<string, string | undefined> = process.env): Context {
  const paths = ensurePaths(resolvePaths(env));
  const box = new SecretBox(loadOrCreateKey(paths.keyFile, env as NodeJS.ProcessEnv));
  return { paths, store: new Store(openDatabase(paths.dbFile), box) };
}
