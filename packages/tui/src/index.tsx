#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Api } from "./api";
import { App } from "./app";
import { loadConfig } from "./config";

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
})();

const api = new Api(config.url, config.token);

// Fail before taking over the terminal — an error is far easier to read here
// than inside a half-initialised full-screen renderer.
try {
  await api.health();
} catch {
  console.error(`Cannot reach the backupbot engine at ${config.url}.`);
  console.error("Is the container running? For a remote NAS: ssh -L 7817:localhost:7817 <nas>");
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
const root = createRoot(renderer);

const quit = () => {
  root.unmount();
  renderer.destroy();
  process.exit(0);
};

root.render(<App api={api} onQuit={quit} />);
