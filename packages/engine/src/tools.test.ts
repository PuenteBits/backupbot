import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dumpSupportsOption } from "./tools";

const workDir = mkdtempSync(`${tmpdir()}/backupbot-tools-`);
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** A stand-in dump binary whose --help lists exactly the options given. */
function stubBinary(name: string, options: string[], stream: "stdout" | "stderr" = "stdout"): string {
  const path = `${workDir}/${name}`;
  const body = options.map((o) => `  --${o}`).join("\n");
  const redirect = stream === "stderr" ? " 1>&2" : "";
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'${redirect}\n${body}\nEOF\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe("dumpSupportsOption", () => {
  test("finds an option the binary advertises", async () => {
    const bin = stubBinary("oracle-like", ["single-transaction", "set-gtid-purged", "routines"]);
    expect(await dumpSupportsOption(bin, "set-gtid-purged")).toBe(true);
  });

  test("reports an option the binary lacks", async () => {
    // This is mariadb-dump: it has no --set-gtid-purged and exits 7 with
    // "unknown variable" if one is passed, so the answer must be no.
    const bin = stubBinary("maria-like", ["single-transaction", "routines", "triggers"]);
    expect(await dumpSupportsOption(bin, "set-gtid-purged")).toBe(false);
  });

  test("reads help written to stderr, which some clients do", async () => {
    const bin = stubBinary("stderr-help", ["set-gtid-purged"], "stderr");
    expect(await dumpSupportsOption(bin, "set-gtid-purged")).toBe(true);
  });

  test("does not match an option that merely shares a prefix", async () => {
    const bin = stubBinary("prefix-only", ["set-gtid-purged-extended"]);
    expect(await dumpSupportsOption(bin, "set-gtid")).toBe(false);
  });

  test("caches per binary, so two clients are not confused for each other", async () => {
    const withOpt = stubBinary("cached-yes", ["set-gtid-purged"]);
    const without = stubBinary("cached-no", ["routines"]);
    expect(await dumpSupportsOption(withOpt, "set-gtid-purged")).toBe(true);
    expect(await dumpSupportsOption(without, "set-gtid-purged")).toBe(false);
    expect(await dumpSupportsOption(withOpt, "set-gtid-purged")).toBe(true);
  });
});
