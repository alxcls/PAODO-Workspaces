// The envelope is what stands between an encrypted-vault snapshot and every recoverable secret.
// These pin round-tripping, tamper detection, and separate key provisioning.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Redirect the key file before the module reads its path at import time.
const { ROOT, KEY_FILE } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-enc-test-"));
  const keyFile = path.join(root, "key", "master.key");
  process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT = path.join(root, "vault");
  process.env.PAODO_WORKSPACE_SECRET_KEY_FILE = keyFile;
  process.env.PAODO_PROVIDER_VAULT_ROOT = path.join(root, "provider-vault");
  process.env.PAODO_PROVIDER_KEY_FILE = path.join(root, "provider-key", "master.key");
  delete (global as Record<string, unknown>)._vaultEncryptionKeys;
  return { ROOT: root, KEY_FILE: keyFile };
});

import { isEncEnvelope, encryptToEnvelope, decryptFromEnvelope, getSecretsEncKey } from "./secretsEncryption";
import { decryptProviderEnvelope, encryptProviderEnvelope, getProviderVaultKey } from "./providerKeyEncryption";
import { WORKSPACE_SECRET_VAULT_KEY_FILE, assertSecretStorageSeparated } from "./secretVaultPaths";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("encrypt/decrypt round trip", () => {
  it("recovers the exact plaintext", () => {
    const plain = JSON.stringify({ ws1: { KEY: { value: "sk-secret-123", domain: "api.example.com" } } });
    expect(decryptFromEnvelope(encryptToEnvelope(plain))).toBe(plain);
  });

  it("does not contain the plaintext in the envelope", () => {
    const env = encryptToEnvelope("sk-super-secret-value");
    expect(JSON.stringify(env)).not.toContain("sk-super-secret-value");
  });

  it("uses a fresh IV per call (identical plaintexts encrypt differently)", () => {
    const a = encryptToEnvelope("same");
    const b = encryptToEnvelope("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});

describe("tamper fails closed", () => {
  const flipFirstByte = (b64: string): string => {
    const buf = Buffer.from(b64, "base64");
    buf[0] ^= 0xff;
    return buf.toString("base64");
  };

  it("throws when ciphertext is modified", () => {
    const env = encryptToEnvelope("payload");
    expect(() => decryptFromEnvelope({ ...env, data: flipFirstByte(env.data) })).toThrow();
  });

  it("throws when the auth tag is modified", () => {
    const env = encryptToEnvelope("payload");
    expect(() => decryptFromEnvelope({ ...env, tag: flipFirstByte(env.tag) })).toThrow();
  });

  it("throws when the IV is modified", () => {
    const env = encryptToEnvelope("payload");
    expect(() => decryptFromEnvelope({ ...env, iv: flipFirstByte(env.iv) })).toThrow();
  });
});

describe("isEncEnvelope", () => {
  it("accepts a real envelope", () => {
    expect(isEncEnvelope(encryptToEnvelope("x"))).toBe(true);
  });

  it("rejects plaintext secret records", () => {
    expect(isEncEnvelope({ ws1: { KEY: { value: "v", createdAt: "t", domain: "d" } } })).toBe(false);
  });

  it("rejects null, arrays, and near-misses", () => {
    expect(isEncEnvelope(null)).toBe(false);
    expect(isEncEnvelope([])).toBe(false);
    expect(isEncEnvelope({ v: 2, alg: "aes-256-gcm", iv: "a", tag: "b", data: "c" })).toBe(false);
    expect(isEncEnvelope({ v: 1, alg: "aes-256-cbc", iv: "a", tag: "b", data: "c" })).toBe(false);
  });
});

describe("key provisioning", () => {
  it("creates a 32-byte key file with mode 0600 and returns it stably", () => {
    const key = getSecretsEncKey();
    expect(key.length).toBe(32);
    expect(getSecretsEncKey()).toBe(key); // cached

    const stat = fs.statSync(KEY_FILE);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(KEY_FILE).equals(key)).toBe(true);
  });

  it("keeps the key outside workspace data and rejects a collapsed boundary", () => {
    expect(WORKSPACE_SECRET_VAULT_KEY_FILE).toBe(KEY_FILE);
    expect(() => assertSecretStorageSeparated(path.join(ROOT, "workspace-data"))).not.toThrow();
    expect(() => assertSecretStorageSeparated(ROOT)).toThrow("must use separate directory trees");
  });

  it("does not replace an existing key after a non-ENOENT read failure", () => {
    getSecretsEncKey();
    const original = fs.readFileSync(KEY_FILE);
    delete (global as Record<string, unknown>)._vaultEncryptionKeys;
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated storage failure"), { code: "EIO" });
    });

    expect(() => getSecretsEncKey()).toThrow("simulated storage failure");
    read.mockRestore();
    expect(fs.readFileSync(KEY_FILE).equals(original)).toBe(true);
  });

  it("uses cryptographically independent provider and workspace-secret keys", () => {
    expect(getProviderVaultKey().equals(getSecretsEncKey())).toBe(false);

    const providerEnvelope = encryptProviderEnvelope("provider-value");
    const workspaceEnvelope = encryptToEnvelope("workspace-value");
    expect(() => decryptFromEnvelope(providerEnvelope)).toThrow();
    expect(() => decryptProviderEnvelope(workspaceEnvelope)).toThrow();
  });
});
