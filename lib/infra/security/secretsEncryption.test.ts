// The envelope is what stands between a copied data/ dir and every workspace secret. These pin
// that encryption round-trips, that any tamper fails closed (throws), and that the key file is
// self-provisioned with the right shape and permissions.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Redirect the key file to a throwaway dir BEFORE the module (via paths.ts) reads
// WORKSPACES_ROOT at import time. Same pattern as apiKeyStore.test.ts.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-enc-test-"));
  process.env.WORKSPACES_ROOT = root;
  delete (global as Record<string, unknown>)._secretsEncKey;
  return { ROOT: root };
});

import { isEncEnvelope, encryptToEnvelope, decryptFromEnvelope, getSecretsEncKey } from "./secretsEncryption";

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

  it("rejects the legacy plaintext store shape", () => {
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

    const keyFile = path.join(ROOT, ".proxy-ca", "secrets-enc.key");
    const stat = fs.statSync(keyFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyFile).equals(key)).toBe(true);
  });

  it("does not replace an existing key after a non-ENOENT read failure", () => {
    getSecretsEncKey();
    const keyFile = path.join(ROOT, ".proxy-ca", "secrets-enc.key");
    const original = fs.readFileSync(keyFile);
    delete (global as Record<string, unknown>)._secretsEncKey;
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated storage failure"), { code: "EIO" });
    });

    expect(() => getSecretsEncKey()).toThrow("simulated storage failure");
    read.mockRestore();
    expect(fs.readFileSync(keyFile).equals(original)).toBe(true);
  });
});
