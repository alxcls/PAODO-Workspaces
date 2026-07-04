// Pins the at-rest guarantees of the secret store: values never hit disk in plaintext, legacy
// plaintext files migrate to the encrypted envelope on first load, and a corrupt/tampered file
// fails closed (empty store) instead of crashing the server.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Redirect the store file to a throwaway dir BEFORE paths.ts reads WORKSPACES_ROOT at import
// time (vi.hoisted runs above imports — same pattern as apiKeyStore.test.ts).
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

const FILE = path.join(ROOT, ".workspace-secrets.json");

// The store loads from disk once at module evaluation and caches on global. To exercise the
// load/migration paths repeatedly, each test clears the caches and re-imports a fresh instance.
async function freshStore() {
  delete (global as Record<string, unknown>)._workspaceSecrets;
  vi.resetModules();
  return await import("./workspaceSecretStore");
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("encryption at rest", () => {
  it("writes an envelope — the raw file never contains the secret value", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "OPENAI_API_KEY", "sk-live-abc123", "api.openai.com");

    const raw = fs.readFileSync(FILE, "utf-8");
    expect(raw).not.toContain("sk-live-abc123");
    expect(raw).not.toContain("api.openai.com");
    const parsed = JSON.parse(raw);
    expect(parsed.alg).toBe("aes-256-gcm");

    // Round trip: a fresh process (fresh import) recovers the value for injection.
    const reloaded = await freshStore();
    const rules = reloaded.getWorkspaceRules("ws1");
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("api.openai.com");
    expect([...rules[0].tokenMap.values()]).toEqual(["sk-live-abc123"]);
  });

  it("migrates a legacy plaintext file to the envelope on first load", async () => {
    const legacy = {
      ws1: { MY_KEY: { value: "legacy-secret", createdAt: "2026-01-01T00:00:00.000Z", domain: "api.example.com" } },
    };
    fs.writeFileSync(FILE, JSON.stringify(legacy));

    const store = await freshStore();
    // Values are readable…
    const rules = store.getWorkspaceRules("ws1");
    expect([...rules[0].tokenMap.values()]).toEqual(["legacy-secret"]);
    // …and the file on disk was immediately re-saved encrypted.
    const raw = fs.readFileSync(FILE, "utf-8");
    expect(raw).not.toContain("legacy-secret");
    expect(JSON.parse(raw).alg).toBe("aes-256-gcm");
  });

  it("fails closed on a tampered envelope: empty store, no crash", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "KEY", "value-1", "api.example.com");

    // Corrupt one ciphertext byte on disk.
    const env = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    const buf = Buffer.from(env.data, "base64");
    buf[0] ^= 0xff;
    env.data = buf.toString("base64");
    fs.writeFileSync(FILE, JSON.stringify(env));

    const reloaded = await freshStore();
    expect(reloaded.listSecretMeta("ws1")).toEqual([]);
    expect(reloaded.getWorkspaceRules("ws1")).toEqual([]);
  });

  it("starts empty when no file exists (first run)", async () => {
    const store = await freshStore();
    expect(store.listSecretMeta("anything")).toEqual([]);
  });
});
