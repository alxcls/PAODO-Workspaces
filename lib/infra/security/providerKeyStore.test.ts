// The provider key store holds the only copy of what the deployment spends money with, so these
// pin the two properties that matter beyond "it round-trips": a value never leaves except through
// getProviderKey, and a store that exists but cannot be read must never be silently replaced by an
// empty one — the next save would destroy every key the operator had.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";

// vi.mock is hoisted above the imports, so the temp root has to be created in a hoisted block too.
const { ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  return { ROOT: mkdtempSync(join(tmpdir(), "provider-keys-")) };
});

// Both this store and secretsEncryption.ts read WORKSPACES_ROOT from the same module, so one mock
// redirects the key file and the store file together into the temp root.
vi.mock("../paths", () => ({ WORKSPACES_ROOT: ROOT }));

import {
  PROVIDER_KEY_STORE_FILE,
  assertProviderKeyStoreAvailable,
  deleteProviderKey,
  getProviderKey,
  hasProviderKey,
  listProviderKeyMeta,
  purgeProviderKeysExcept,
  setProviderKey,
  _resetProviderKeysForTest,
} from "./providerKeyStore";

beforeEach(() => {
  _resetProviderKeysForTest();
  rmSync(PROVIDER_KEY_STORE_FILE, { force: true });
});

describe("provider key round-trip", () => {
  it("gives back the key it was handed", () => {
    setProviderKey("anthropic", "sk-ant-secret-value");
    expect(getProviderKey("anthropic")).toBe("sk-ant-secret-value");
  });

  it("reports no key for a provider that never had one", () => {
    expect(getProviderKey("openai")).toBeUndefined();
    expect(hasProviderKey("openai")).toBe(false);
  });

  it("replaces in place rather than accumulating versions", () => {
    setProviderKey("openai", "first");
    setProviderKey("openai", "second");
    expect(getProviderKey("openai")).toBe("second");
    expect(listProviderKeyMeta()).toHaveLength(1);
  });

  it("deletes, and reports whether there was anything to delete", () => {
    setProviderKey("mistral", "key");
    expect(deleteProviderKey("mistral")).toBe(true);
    expect(deleteProviderKey("mistral")).toBe(false);
    expect(getProviderKey("mistral")).toBeUndefined();
  });
});

describe("what leaves the module", () => {
  it("never puts a value in the metadata", () => {
    setProviderKey("anthropic", "sk-ant-the-actual-secret");
    const [meta] = listProviderKeyMeta();
    // Asserting on the serialized shape, not on named fields: a field added later that happens to
    // carry the value would pass a key-by-key check and fail this one.
    expect(JSON.stringify(meta)).not.toContain("sk-ant-the-actual-secret");
    expect(meta).toEqual({ provider: "anthropic", createdAt: expect.any(String), hint: "cret" });
  });

  it("shows a short value whole rather than hiding a typo", () => {
    // A value this short cannot be a real key, and masking it only makes the mistake harder to see.
    setProviderKey("openai", "abc");
    expect(listProviderKeyMeta()[0].hint).toBe("abc");
  });
});

describe("encryption at rest", () => {
  it("writes an envelope, with no key material readable in the file", () => {
    setProviderKey("deepseek", "sk-plaintext-would-be-a-leak");

    const raw = readFileSync(PROVIDER_KEY_STORE_FILE, "utf8");
    expect(raw).not.toContain("sk-plaintext-would-be-a-leak");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: "aes-256-gcm" });
  });
});

describe("purgeProviderKeysExcept", () => {
  it("deletes exactly the providers not allowed, and names them", () => {
    setProviderKey("anthropic", "a");
    setProviderKey("openai", "o");
    setProviderKey("mistral", "m");

    expect(purgeProviderKeysExcept(["anthropic", "mistral"])).toEqual(["openai"]);

    expect(getProviderKey("openai")).toBeUndefined();
    expect(getProviderKey("anthropic")).toBe("a");
    expect(getProviderKey("mistral")).toBe("m");
  });

  it("purges a provider that has left the registry entirely, not just one switched off", () => {
    setProviderKey("retired-vendor", "k");
    expect(purgeProviderKeysExcept(["anthropic"])).toEqual(["retired-vendor"]);
  });

  it("does nothing, and writes nothing, when every stored provider is still allowed", () => {
    setProviderKey("anthropic", "a");
    rmSync(PROVIDER_KEY_STORE_FILE, { force: true });

    expect(purgeProviderKeysExcept(["anthropic", "openai"])).toEqual([]);
    // No save on a no-op: an unnecessary write is a chance to fail while destroying nothing.
    expect(existsSync(PROVIDER_KEY_STORE_FILE)).toBe(false);
  });
});

// Loading happens once at module import, so these reload the module against a file planted first.
// The global holder has to be cleared too — it is what makes the store survive module reloads in
// production, and it would otherwise make the re-import skip the load entirely.
async function reload() {
  delete (global as typeof global & { _providerKeys?: unknown })._providerKeys;
  vi.resetModules();
  return import("./providerKeyStore");
}

describe("a store that cannot be read", () => {
  it("starts empty but refuses to let startup continue", async () => {
    // Valid JSON, not an envelope — the shape a partial write or a hand-edit leaves behind.
    writeFileSync(PROVIDER_KEY_STORE_FILE, JSON.stringify({ anthropic: { value: "k" } }));

    const store = await reload();

    // Empty in memory is survivable; serving requests from it is not, because the first save would
    // overwrite the unreadable file and destroy whatever it really held.
    expect(store.getProviderKey("anthropic")).toBeUndefined();
    expect(() => store.assertProviderKeyStoreAvailable()).toThrow();
  });

  it("treats a missing file as the normal first run", async () => {
    rmSync(PROVIDER_KEY_STORE_FILE, { force: true });

    const store = await reload();

    expect(store.listProviderKeyMeta()).toEqual([]);
    expect(() => store.assertProviderKeyStoreAvailable()).not.toThrow();
  });

  it("reads back keys written by an earlier process", async () => {
    setProviderKey("anthropic", "survives-a-restart");

    const store = await reload();

    expect(store.getProviderKey("anthropic")).toBe("survives-a-restart");
  });
});

describe("assertProviderKeyStoreAvailable", () => {
  it("passes for a store that loaded cleanly", () => {
    expect(() => assertProviderKeyStoreAvailable()).not.toThrow();
  });
});
