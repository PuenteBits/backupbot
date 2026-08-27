import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SecretBox } from "./crypto";
import { inspectDsn, maskDsn, parseDsn } from "./dsn";
import { redact } from "./redact";
import { slugify } from "./schema";

describe("SecretBox", () => {
  const box = new SecretBox(randomBytes(32));

  test("round-trips a connection string", () => {
    const dsn = "postgres://user:p@ss:word/1@host:5432/db";
    expect(box.decrypt(box.encrypt(dsn))).toBe(dsn);
  });

  test("produces a different ciphertext each time", () => {
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  test("rejects a payload encrypted under a different key", () => {
    const other = new SecretBox(randomBytes(32));
    expect(() => other.decrypt(box.encrypt("secret"))).toThrow();
  });

  test("rejects a tampered payload", () => {
    const [v, iv, tag, ct] = box.encrypt("secret").split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    expect(() => box.decrypt([v, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });
});

describe("parseDsn", () => {
  test("decodes a percent-encoded password", () => {
    const parsed = parseDsn("postgres://postgres:p%40ss%3Aword%2F1@db.example.com:5432/shop");
    expect(parsed.password).toBe("p@ss:word/1");
    expect(parsed.database).toBe("shop");
    expect(parsed.port).toBe(5432);
  });

  test("defaults the port per engine", () => {
    expect(parseDsn("mysql://u:p@h/db").port).toBe(3306);
    expect(parseDsn("postgresql://u:p@h/db").port).toBe(5432);
  });

  test("requires a database name", () => {
    expect(() => parseDsn("postgres://u:p@h:5432/")).toThrow(/database/);
  });

  test("rejects an unsupported engine", () => {
    expect(() => parseDsn("mongodb://u:p@h/db")).toThrow(/unsupported scheme/);
  });
});

describe("maskDsn", () => {
  test("hides the password", () => {
    const masked = maskDsn("postgres://u:hunter2@h:5432/db");
    expect(masked).not.toContain("hunter2");
    expect(masked).toContain("h:5432");
  });

  test("never leaks anything for an unparseable string", () => {
    expect(maskDsn("not a url with hunter2 in it")).toBe("****");
  });
});

describe("inspectDsn", () => {
  test("flags Supabase's transaction pooler as fatal for pg_dump", () => {
    const warnings = inspectDsn(parseDsn("postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"));
    expect(warnings.some((w) => w.level === "error" && /6543/.test(w.message))).toBe(true);
  });

  test("accepts the session pooler without an error", () => {
    const warnings = inspectDsn(parseDsn("postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require"));
    expect(warnings.filter((w) => w.level === "error")).toHaveLength(0);
  });

  test("warns about IPv6-only Supabase direct connections", () => {
    const warnings = inspectDsn(parseDsn("postgres://u:p@db.abcdefgh.supabase.co:5432/postgres"));
    expect(warnings.some((w) => /IPv6/.test(w.message))).toBe(true);
  });
});

describe("redact", () => {
  test("scrubs a password and its percent-encoded form", () => {
    const secret = "p@ssw0rd";
    const text = `connection to postgres://u:${secret}@h/db failed; retried with ${encodeURIComponent(secret)}`;
    const out = redact(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encodeURIComponent(secret));
  });

  test("leaves short strings alone so it cannot mangle unrelated output", () => {
    expect(redact("the db is up", ["up"])).toBe("the db is up");
  });
});

describe("slugify", () => {
  test("makes a filesystem-safe directory name", () => {
    expect(slugify("Shop — Production DB!")).toBe("shop-production-db");
  });

  test("throws rather than produce an empty slug", () => {
    expect(() => slugify("!!!")).toThrow();
  });
});
