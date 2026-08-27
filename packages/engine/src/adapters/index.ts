import type { Engine } from "@backupbot/core";
import { mysqlAdapter } from "./mysql";
import { postgresAdapter } from "./postgres";
import type { Adapter } from "../types";

const ADAPTERS: Record<Engine, Adapter> = {
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
};

export function adapterFor(engine: Engine): Adapter {
  const adapter = ADAPTERS[engine];
  if (!adapter) throw new Error(`no adapter for engine "${engine}"`);
  return adapter;
}

export { postgresAdapter, mysqlAdapter };
