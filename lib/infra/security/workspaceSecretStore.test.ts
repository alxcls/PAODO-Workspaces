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
    store.setSecret("ws1", "OPENAI_API_KEY", "sk-live-abc123", ["api.openai.com"]);

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

  it("supports multiple allowed hosts per secret", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "GITHUB_PAT", "ghp_secret", ["github.com", "api.GitHub.com", " https://api.github.com/path "]);

    const meta = store.listSecretMeta("ws1");
    expect(meta[0].domains).toEqual(["api.github.com", "github.com"]);

    const rules = store.getWorkspaceRules("ws1").sort((a, b) => a.domain.localeCompare(b.domain));
    expect(rules.map((r) => r.domain)).toEqual(["api.github.com", "github.com"]);
    expect(rules[0].tokenMap.size + rules[1].tokenMap.size).toBe(2);
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
    store.setSecret("ws1", "KEY", "value-1", ["api.example.com"]);

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

describe("proxyToken", () => {
  it("is stable and alphanumeric-only so common CLIs can accept it before the proxy substitutes it", async () => {
    const { proxyToken } = await freshStore();
    const token = proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "VERCEL_TOKEN");
    expect(token).toMatch(/^p[a-f0-9]{64}$/);
    expect(proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "VERCEL_TOKEN")).toBe(token);
    expect(proxyToken("3923f8e7-c383-4802-a270-66877ea0a940", "OTHER_TOKEN")).not.toBe(token);
  });

  it("maps only its CLI-safe token to the real value", async () => {
    const store = await freshStore();
    store.setSecret("ws1", "API_KEY", "real-value", ["api.example.com"]);
    const { proxyToken } = store;
    const map = store.getWorkspaceRules("ws1")[0].tokenMap;
    expect(map.get(proxyToken("ws1", "API_KEY"))).toBe("real-value");
    expect(map.size).toBe(1);
  });
});

describe("reloadSecretStore (credential-proxy sidecar reader)", () => {
  it("picks up secrets written by another process after reload", async () => {
    // `reader` models the sidecar: it loaded the store once, then the app (a separate in-memory
    // instance sharing the same file) mutates secrets on disk. Only reloadSecretStore() makes the
    // reader see them.
    const reader = await freshStore();
    reader.setSecret("ws1", "K1", "v1", ["api.openai.com"]); 
    expect(reader.listSecretWorkspaceIds()).toEqual(["ws1"]);

    const app = await freshStore(); // fresh in-memory instance, same FILE on disk
    app.setSecret("ws2", "K2", "v2", ["api.example.com"]);

    // Reader is stale until it reloads.
    expect(reader.listSecretWorkspaceIds()).toEqual(["ws1"]);
    reader.reloadSecretStore();
    expect(reader.listSecretWorkspaceIds().sort()).toEqual(["ws1", "ws2"]);

    expect(reader.getWorkspaceRules("ws2")).toEqual([
      { domain: "api.example.com", tokenMap: new Map([[reader.proxyToken("ws2", "K2"), "v2"]]) },
    ]);
  });

  it("drops a workspace whose secrets were all removed on disk after reload", async () => {
    const reader = await freshStore();
    reader.setSecret("ws1", "K1", "v1", ["api.openai.com"]);
    expect(reader.listSecretWorkspaceIds()).toEqual(["ws1"]);

    const app = await freshStore();
    app.setSecret("ws1", "K1", "v1", ["api.openai.com"]); // load current state
    app.deleteAllForWorkspace("ws1");

    reader.reloadSecretStore();
    expect(reader.listSecretWorkspaceIds()).toEqual([]);
  });
});

describe("selectGithubTokenSecret", () => {
  it("returns null when no secret is scoped to github.com", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([])).toBeNull();
    expect(selectGithubTokenSecret([{ name: "OPENAI_KEY", domains: ["api.openai.com"] }])).toBeNull();
  });

  it("picks the github.com-scoped secret regardless of its name", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([{ name: "MY_PAT", domains: ["github.com"] }])).toBe("MY_PAT");
  });

  it("prefers GITHUB_TOKEN, then GH_TOKEN, then a GITHUB/GH-ish name on ties", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    const gh = { name: "GH_TOKEN", domains: ["github.com"] };
    const ghToken = { name: "GITHUB_TOKEN", domains: ["github.com"] };
    const ish = { name: "MY_GH_PAT", domains: ["github.com"] };
    const plain = { name: "MY_PAT", domains: ["github.com"] };
    expect(selectGithubTokenSecret([plain, gh, ghToken])).toBe("GITHUB_TOKEN");
    expect(selectGithubTokenSecret([plain, gh])).toBe("GH_TOKEN");
    expect(selectGithubTokenSecret([plain, ish])).toBe("MY_GH_PAT");
    expect(selectGithubTokenSecret([plain])).toBe("MY_PAT");
  });

  it("does not treat an incidental GH/GITHUB substring as a token-name match on ties", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    // HIGH_SCORE contains "GH" but is not a github token name; with two non-special candidates the
    // GH/GITHUB tiebreak must skip it and fall through to the first candidate.
    const high = { name: "HIGH_SCORE", domains: ["github.com"] };
    const plain = { name: "MY_PAT", domains: ["github.com"] };
    expect(selectGithubTokenSecret([high, plain])).toBe("HIGH_SCORE"); // falls through to first
    // But a real token-style name still wins the tiebreak over a plain one.
    expect(selectGithubTokenSecret([high, { name: "MY_GITHUB_PAT", domains: ["github.com"] }])).toBe("MY_GITHUB_PAT");
  });

  it("requires an exact github.com host — subdomains like api.github.com do not qualify", async () => {
    const { selectGithubTokenSecret } = await freshStore();
    expect(selectGithubTokenSecret([{ name: "API_ONLY", domains: ["api.github.com"] }])).toBeNull();
  });
});
