import { describe, expect, test } from "bun:test";
import { parseDsn } from "@backupbot/core";
import { sslSettings } from "./mysql";

const settingsFor = (dsn: string) => sslSettings(parseDsn(dsn));

describe("sslSettings", () => {
  test("a remote host encrypts without verifying, which is what managed MySQL needs", () => {
    // Railway, PlanetScale and friends terminate TLS with a self-signed cert;
    // the MariaDB client verifies by default and fails with
    // "self-signed certificate in certificate chain" before a dump can start.
    expect(settingsFor("mysql://u:p@shop.proxy.rlwy.net:41234/railway")).toEqual([
      "ssl=1",
      "ssl-verify-server-cert=0",
    ]);
  });

  test("never emits ssl-mode, which the MariaDB client rejects outright", () => {
    for (const dsn of [
      "mysql://u:p@host.example.com:3306/db",
      "mysql://u:p@host.example.com:3306/db?ssl-mode=REQUIRED",
      "mysql://u:p@host.example.com:3306/db?ssl-mode=DISABLED",
      "mysql://root:pw@127.0.0.1:3306/shop",
    ]) {
      expect(settingsFor(dsn).some((line) => line.startsWith("ssl-mode="))).toBe(false);
    }
  });

  test("translates each portable ssl-mode to the MariaDB spelling", () => {
    const host = "mysql://u:p@host.example.com:3306/db?ssl-mode=";
    expect(settingsFor(`${host}DISABLED`)).toEqual(["ssl=0"]);
    expect(settingsFor(`${host}PREFERRED`)).toEqual(["ssl-verify-server-cert=0"]);
    expect(settingsFor(`${host}REQUIRED`)).toEqual(["ssl=1", "ssl-verify-server-cert=0"]);
    expect(settingsFor(`${host}VERIFY_CA`)).toEqual(["ssl=1", "ssl-verify-server-cert=1"]);
    expect(settingsFor(`${host}VERIFY_IDENTITY`)).toEqual(["ssl=1", "ssl-verify-server-cert=1"]);
  });

  test("accepts the hyphenated and lowercase spellings providers hand out", () => {
    const expected = ["ssl=1", "ssl-verify-server-cert=1"];
    expect(settingsFor("mysql://u:p@host.example.com:3306/db?ssl-mode=verify-ca")).toEqual(expected);
    expect(settingsFor("mysql://u:p@host.example.com:3306/db?ssl-mode=VERIFY-CA")).toEqual(expected);
  });

  test("a local host does not force TLS but still never fails on a certificate", () => {
    expect(settingsFor("mysql://root:pw@127.0.0.1:3306/shop")).toEqual(["ssl-verify-server-cert=0"]);
  });

  test("passes a CA through for the modes that can use one", () => {
    expect(settingsFor("mysql://u:p@host.example.com:3306/db?ssl-mode=VERIFY_CA&ssl-ca=/etc/ca.pem")).toEqual([
      "ssl=1",
      "ssl-verify-server-cert=1",
      "ssl-ca=/etc/ca.pem",
    ]);
  });

  test("rejects a typo rather than silently falling back to something weaker", () => {
    expect(() => settingsFor("mysql://u:p@host.example.com:3306/db?ssl-mode=REQURED")).toThrow(/unknown ssl-mode/);
  });
});
