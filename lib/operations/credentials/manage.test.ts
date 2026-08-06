import { describe, expect, it, vi } from "vitest";
import {
  getCredentialState,
  issueCredential,
  revokeCredential,
  setCredentialEnabled,
  type CredentialLifecycleStore,
} from "./manage";

function fixture(hasKey = false, enabled = false) {
  let current = { enabled, hasKey, createdAt: null, lastUsedAt: null };
  const store: CredentialLifecycleStore = {
    state: vi.fn(() => current),
    mint: vi.fn(() => {
      current = { ...current, hasKey: true };
      return "plain-secret";
    }),
    revoke: vi.fn(() => {
      current = { ...current, hasKey: false };
    }),
    setEnabled: vi.fn((_kind, _subject, next) => {
      current = { ...current, enabled: next };
    }),
  };
  return store;
}

describe("credential lifecycle operations", () => {
  it("generates only into an empty slot and rotates only an existing key", () => {
    const empty = fixture();
    // The two axes travel with the plaintext: a key minted against a closed channel is real and
    // rejected on every call, and the receipt that carries it is the only one a caller can ever read.
    expect(issueCredential("workspace-api", "ws-1", "generate", empty)).toEqual({
      plain: "plain-secret",
      enabled: false,
      hasKey: true,
    });
    expect(() => issueCredential("workspace-api", "ws-1", "generate", empty)).toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_ALREADY_CONFIGURED" }),
    );
    expect(issueCredential("workspace-api", "ws-1", "rotate", empty)).toEqual({
      plain: "plain-secret",
      enabled: false,
      hasKey: true,
    });

    const missing = fixture();
    expect(() => issueCredential("workspace-mcp", "ws-1", "rotate", missing)).toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_NOT_CONFIGURED" }),
    );
  });

  it("validates the requested issue operation before touching the store", () => {
    const store = fixture();
    expect(() => issueCredential("platform", null, "replace", store)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field: "operation" } }),
    );
    expect(store.state).not.toHaveBeenCalled();
  });

  it("revokes a configured key and returns the resulting channel state", () => {
    const store = fixture(true, true);
    expect(revokeCredential("workspace-api", "ws-1", store)).toEqual({
      ok: true,
      credentialKind: "workspace-api",
      subject: "ws-1",
      enabled: true,
      hasKey: false,
    });
    expect(() => revokeCredential("workspace-api", "ws-1", store)).toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_NOT_CONFIGURED" }),
    );
  });

  it("reads and toggles state without exposing store representation details", () => {
    const store = fixture(false, false);
    setCredentialEnabled("platform", null, true, store);
    expect(getCredentialState("platform", null, store)).toMatchObject({ enabled: true, hasKey: false });
    expect(() => setCredentialEnabled("platform", null, "yes", store)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
