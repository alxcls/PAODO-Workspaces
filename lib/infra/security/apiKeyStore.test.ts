// validateKey is the auth chokepoint for programmatic agent calls; these pin that
// it fails closed (no key / disabled / revoked / wrong) and accepts only the legit case.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";

// Redirect the on-disk store to a throwaway temp dir BEFORE apiKeyStore (via
// paths.ts) reads WORKSPACES_ROOT at import time. vi.hoisted runs above the
// imports, so the module persists keys into the temp dir, never the real ./data.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apikey-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import { generateKey, setKey, revokeKey, setEnabled, validateKey } from "./apiKeyStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// validateKey is the authentication chokepoint for programmatic agent calls
// (POST /api/agent → 401 when it returns false). The dangerous bug is the
// inverse of the path/SSRF guards: not "lets too much through a path" but
// "authorizes a request it should have denied." Because the API-key feature is
// OFF by default for most workspaces, the deny paths below are the COMMON
// runtime states — so they are exactly what must fail closed. Each test uses a
// distinct workspace id since the store is a process-global shared across tests.

describe("validateKey — auth fails closed", () => {
  it("denies a workspace that never had a key configured (default state)", () => {
    expect(validateKey("never-configured", "sk_anything")).toBe(false);
  });

  it("denies even the CORRECT key when the workspace is disabled", () => {
    // The headline case: toggling the feature off must lock the door regardless
    // of whether the caller holds a once-valid key.
    const { plain, hash } = generateKey();
    setKey("ws-disabled", hash); // setKey enables by default
    expect(validateKey("ws-disabled", plain)).toBe(true); // sanity: works while enabled

    setEnabled("ws-disabled", false);
    expect(validateKey("ws-disabled", plain)).toBe(false);
  });

  it("denies a revoked key (keyHash cleared) even if still enabled", () => {
    const { plain, hash } = generateKey();
    setKey("ws-revoked", hash);
    revokeKey("ws-revoked");
    expect(validateKey("ws-revoked", plain)).toBe(false);
  });

  it("denies an incorrect key on an enabled workspace", () => {
    const { hash } = generateKey();
    setKey("ws-wrongkey", hash);
    const other = generateKey().plain;
    expect(validateKey("ws-wrongkey", other)).toBe(false);
    expect(validateKey("ws-wrongkey", "")).toBe(false);
  });
});

describe("validateKey — authorizes the legitimate case", () => {
  it("accepts the correct key on an enabled workspace", () => {
    const { plain, hash } = generateKey();
    setKey("ws-valid", hash);
    expect(validateKey("ws-valid", plain)).toBe(true);
  });

  it("accepts again after the key is disabled then re-enabled", () => {
    const { plain, hash } = generateKey();
    setKey("ws-toggle", hash);
    setEnabled("ws-toggle", false);
    expect(validateKey("ws-toggle", plain)).toBe(false);
    setEnabled("ws-toggle", true);
    expect(validateKey("ws-toggle", plain)).toBe(true);
  });
});

describe("generateKey", () => {
  it("returns an sk_-prefixed secret whose hash matches setKey/validateKey", () => {
    const { plain, hash } = generateKey();
    expect(plain.startsWith("sk_")).toBe(true);
    // The hash stored via setKey must validate against the plaintext — i.e.
    // generateKey's plain and hash are a matching pair.
    setKey("ws-gen", hash);
    expect(validateKey("ws-gen", plain)).toBe(true);
  });

  it("produces a unique secret each call", () => {
    expect(generateKey().plain).not.toBe(generateKey().plain);
  });
});
