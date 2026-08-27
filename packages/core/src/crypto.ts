import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`master key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(payload: string): string {
    const [prefix, ivB64, tagB64, ctB64] = payload.split(":");
    if (prefix !== PREFIX || !ivB64 || !tagB64 || !ctB64) {
      throw new Error("malformed ciphertext");
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    // Throws if the key is wrong or the payload was tampered with.
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }
}

/**
 * Loads the master key, generating it on first run. BACKUPBOT_KEY (64 hex
 * chars) wins over the key file so secrets can be injected by an orchestrator.
 */
export function loadOrCreateKey(keyFile: string, env = process.env): Buffer {
  const fromEnv = env.BACKUPBOT_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv.trim(), "hex");
    if (key.length !== KEY_BYTES) throw new Error("BACKUPBOT_KEY must be 64 hex characters");
    return key;
  }
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
    if (key.length !== KEY_BYTES) throw new Error(`${keyFile} does not contain a 32-byte hex key`);
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyFile, key.toString("hex") + "\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

/** Constant-time compare for API bearer tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
