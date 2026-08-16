// Shared AES-256-GCM envelope mechanics. Storage-specific wrappers choose the key file and cache
// slot so provider credentials and workspace-injected secrets can never accidentally share a key.
import fs from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { createLogger } from "../logger";
import { createKeyFile } from "./keyFile";

export interface EncEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export function isEncEnvelope(value: unknown): value is EncEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.v === 1 &&
    envelope.alg === "aes-256-gcm" &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.data === "string"
  );
}

const g = global as typeof global & { _vaultEncryptionKeys?: Record<string, Buffer> };

export function getVaultKey(keyFile: string, cacheSlot: string, logContext: string): Buffer {
  // Tests deliberately clear the global to model a fresh process. Recreate it here rather than
  // only at module evaluation; hot reload can produce the same sequence in development.
  const keyCache = (g._vaultEncryptionKeys ??= {});
  const cached = keyCache[cacheSlot];
  if (cached) return cached;

  const log = createLogger(logContext);
  let key: Buffer;
  try {
    key = fs.readFileSync(keyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        { event: "vault_encryption_key_read_failed", outcome: "encryption_operation_failed", err, keyFile },
        "failed to read vault encryption key",
      );
      throw err;
    }
    key = createKeyFile(keyFile);
  }
  if (key.length !== 32) throw new Error("vault encryption key is corrupt (expected 32 bytes)");
  keyCache[cacheSlot] = key;
  return key;
}

export function encryptWithKey(plaintext: string, key: Buffer): EncEnvelope {
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

export function decryptWithKey(envelope: EncEnvelope, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}
