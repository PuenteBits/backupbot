import { describe, expect, test } from "bun:test";
import { resolveRemoteOptions } from "./remote";

describe("resolveRemoteOptions", () => {
  test("takes the host from the first argument", () => {
    expect(resolveRemoteOptions(["nas"], {}).host).toBe("nas");
  });

  test("falls back to BACKUPBOT_SSH_HOST", () => {
    expect(resolveRemoteOptions([], { BACKUPBOT_SSH_HOST: "nas" }).host).toBe("nas");
  });

  test("an explicit argument wins over the environment", () => {
    expect(resolveRemoteOptions(["from-argv"], { BACKUPBOT_SSH_HOST: "from-env" }).host).toBe("from-argv");
  });

  test("explains itself when no host is given at all", () => {
    expect(() => resolveRemoteOptions([], {})).toThrow(/No SSH host/);
  });

  test("defaults the remote port and database to the documented deployment", () => {
    const options = resolveRemoteOptions(["nas"], {});
    expect(options.remotePort).toBe(7817);
    expect(options.remoteDb).toBe("/volume1/docker/backupbot/data/backupbot.sqlite");
    expect(options.token).toBeNull();
  });

  test("a supplied token means the NAS is never asked for one", () => {
    const options = resolveRemoteOptions(["nas"], { BACKUPBOT_TOKEN: "abc123" });
    expect(options.token).toBe("abc123");
  });

  test("honours an engine deployed somewhere else", () => {
    const options = resolveRemoteOptions(["nas"], {
      BACKUPBOT_REMOTE_PORT: "9000",
      BACKUPBOT_REMOTE_DB: "/srv/backupbot/backupbot.sqlite",
    });
    expect(options.remotePort).toBe(9000);
    expect(options.remoteDb).toBe("/srv/backupbot/backupbot.sqlite");
  });
});
