// AES-256-GCM encryption for the workspace secret store's on-disk file.
// The plaintext must stay recoverable (the proxy injects real values), so this is not hashing —
// it protects the file at rest: backups, volume snapshots, or an accidentally copied data/ dir
// no longer expose every secret. An attacker with live host access can still read the key; that
// is out of scope here (same stance as the proxy CA key, see the workspace-secrets ADR).
//
// Key handling mirrors the proxy HMAC key (proxyCA.ts ensureProxyHmacKey): host-only file under
// data/.proxy-ca/, mode 0600, cached on `global` so the custom server and Next.js route bundles
// (separate module instances) share one key. Unlike the HMAC key it is generated ON DEMAND rather
// than from ensureCA(): the secret store loads synchronously at module import, which happens
// before server startup runs ensureCA() — and route bundles have no startup hook at all.
import fs from "fs";
import path from "path";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { WORKSPACES_ROOT } from "../paths";
import { createLogger } from "../logger";
import { createKeyFile } from "./keyFile";

const KEY_FILE = path.join(WORKSPACES_ROOT, ".proxy-ca", "secrets-enc.key");
const log = createLogger("secretStore");

// Envelope persisted (via atomicSaveJson) in place of the legacy plaintext store JSON. Still a
// .json file; trivially distinguishable from the legacy shape (wsId → name → entry objects).
export interface EncEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16-byte GCM auth tag
  data: string; // base64 ciphertext
}

export function isEncEnvelope(x: unknown): x is EncEnvelope {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    e.alg === "aes-256-gcm" &&
    typeof e.iv === "string" &&
    typeof e.tag === "string" &&
    typeof e.data === "string"
  );
}

const g = global as typeof global & { _secretsEncKey?: Buffer };

export function getSecretsEncKey(): Buffer {
  if (g._secretsEncKey) return g._secretsEncKey;
  let key: Buffer;
  try {
    key = fs.readFileSync(KEY_FILE);
  } catch (err) {
    // Missing is the only safe provisioning case. Overwriting an existing key after EACCES/EIO
    // would make every secret encrypted with the old key permanently unrecoverable.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        {
          event: "secrets_encryption_key_read_failed",
          outcome: "encryption_operation_failed",
          err,
          filePath: KEY_FILE,
        },
        "failed to read secrets encryption key",
      );
      throw err;
    }
    // First use: createKeyFile mkdirs because .proxy-ca/ may not exist yet — ensureCA() has not
    // necessarily run when the store imports us.
    key = createKeyFile(KEY_FILE);
  }
  if (key.length !== 32) throw new Error("secrets encryption key is corrupt (expected 32 bytes)");
  g._secretsEncKey = key;
  return key;
}

export function encryptToEnvelope(plaintext: string): EncEnvelope {
  const key = getSecretsEncKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

// Throws on any tamper (GCM auth failure), wrong key, or malformed envelope — callers fail closed.
export function decryptFromEnvelope(env: EncEnvelope): string {
  const key = getSecretsEncKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]).toString("utf8");
}
