// validate() is the authentication chokepoint for every programmatic caller — the agent API, the
// workspace MCP endpoint, and the CLI. The dangerous bug here is not "leaks too much data" but
// "authorizes a request it should have denied", so the deny paths are what these tests pin.
//
// They matter more than they look: every access channel is OFF by default, so "no secret" and
// "disabled" are the COMMON runtime states, not edge cases. The matrix runs once per kind because a
// single unified store means a mistake in one shared branch fails all three channels at once.

import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";

// Redirect the on-disk store to a throwaway temp dir BEFORE credentialStore (via paths.ts) reads
// WORKSPACES_ROOT at import time. vi.hoisted runs above the imports, so the module persists into the
// temp dir, never the real ./data.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import {
  type CredentialKind,
  type CredentialSubject,
  mint,
  remove,
  removeWorkspace,
  revoke,
  setEnabled,
  state,
  validate,
} from "./credentialStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Each kind with a subject that keeps its records distinct from other tests', since the store is a
// process-global shared across this file. Workspace ids are suffixed per-case below.
const KINDS: ReadonlyArray<{ kind: CredentialKind; prefix: string; subject: (name: string) => CredentialSubject }> = [
  { kind: "workspace-api", prefix: "sk_", subject: (name) => `ws-api-${name}` },
  { kind: "workspace-mcp", prefix: "mcp_", subject: (name) => `ws-mcp-${name}` },
  // The platform credential is instance-wide, so every case shares the one record. Ordering within a
  // case is therefore what matters — each mint() below fully overwrites the previous state.
  { kind: "platform", prefix: "cli_", subject: () => null },
];

describe.each(KINDS)("$kind — validate fails closed", ({ kind, prefix, subject }) => {
  it("denies a credential that was never configured", () => {
    expect(validate(kind, subject("never-configured"), "anything")).toBe(false);
  });

  it("denies the CORRECT secret once the channel is disabled", () => {
    // The headline case: toggling access off must lock the door even for a caller holding a
    // once-valid secret.
    const target = subject("disabled");
    const plain = mint(kind, target);
    expect(validate(kind, target, plain)).toBe(true); // sanity: works while enabled

    setEnabled(kind, target, false);
    expect(validate(kind, target, plain)).toBe(false);
  });

  it("denies a revoked secret even while the channel stays enabled", () => {
    const target = subject("revoked");
    const plain = mint(kind, target);
    revoke(kind, target);
    expect(state(kind, target).enabled).toBe(true);
    expect(validate(kind, target, plain)).toBe(false);
  });

  it("denies a wrong or empty secret on an enabled channel", () => {
    const target = subject("wrong");
    mint(kind, target);
    // A well-formed secret that was never minted — same prefix and length as the real thing, so this
    // pins the hash comparison rather than a cheap shape check. A literal is used instead of a second
    // mint() because the platform credential is instance-wide: minting again would overwrite the
    // record under test and hand back its current valid secret.
    expect(validate(kind, target, `${prefix}${"0".repeat(64)}`)).toBe(false);
    expect(validate(kind, target, "")).toBe(false);
  });

  it("denies the previous secret after rotation, and accepts the new one", () => {
    const target = subject("rotated");
    const previous = mint(kind, target);
    const current = mint(kind, target);
    expect(validate(kind, target, previous)).toBe(false);
    expect(validate(kind, target, current)).toBe(true);
  });

  it("denies a removed credential", () => {
    const target = subject("removed");
    const plain = mint(kind, target);
    remove(kind, target);
    expect(validate(kind, target, plain)).toBe(false);
  });
});

describe.each(KINDS)("$kind — validate authorizes the legitimate case", ({ kind, prefix, subject }) => {
  it("mints a prefixed secret that validates while enabled", () => {
    const target = subject("valid");
    const plain = mint(kind, target);
    expect(plain.startsWith(prefix)).toBe(true);
    expect(validate(kind, target, plain)).toBe(true);
  });

  it("accepts again after disable then re-enable", () => {
    const target = subject("toggle");
    const plain = mint(kind, target);
    setEnabled(kind, target, false);
    expect(validate(kind, target, plain)).toBe(false);
    setEnabled(kind, target, true);
    expect(validate(kind, target, plain)).toBe(true);
  });

  it("produces a unique secret per mint", () => {
    expect(mint(kind, subject("unique-a"))).not.toBe(mint(kind, subject("unique-b")));
  });
});

describe("state — never exposes a hash", () => {
  it("returns only the public fields", () => {
    mint("workspace-api", "ws-state");
    // Asserting on the key set, not just the absence of one name: a future field carrying hash
    // material would fail this instead of slipping through to a JSON response.
    expect(Object.keys(state("workspace-api", "ws-state")).sort()).toEqual([
      "createdAt",
      "enabled",
      "hasSecret",
      "lastUsedAt",
    ]);
  });

  it("reports a channel enabled before any secret exists", () => {
    // The UI's "enabled, secret required" state — enabling must not imply a usable credential.
    setEnabled("workspace-api", "ws-no-secret", true);
    expect(state("workspace-api", "ws-no-secret")).toMatchObject({ enabled: true, hasSecret: false });
    expect(validate("workspace-api", "ws-no-secret", "sk_anything")).toBe(false);
  });

  it("reports hasSecret false after revocation", () => {
    mint("workspace-api", "ws-state-revoked");
    revoke("workspace-api", "ws-state-revoked");
    expect(state("workspace-api", "ws-state-revoked")).toMatchObject({ enabled: true, hasSecret: false });
  });

  it("records createdAt on mint and lastUsedAt on first successful validate", () => {
    const plain = mint("workspace-api", "ws-timestamps");
    expect(state("workspace-api", "ws-timestamps")).toMatchObject({ lastUsedAt: null });
    expect(typeof state("workspace-api", "ws-timestamps").createdAt).toBe("string");

    validate("workspace-api", "ws-timestamps", plain);
    expect(state("workspace-api", "ws-timestamps").lastUsedAt).not.toBeNull();
  });

  it("does not record lastUsedAt for a failed validate", () => {
    mint("workspace-api", "ws-failed-use");
    validate("workspace-api", "ws-failed-use", "sk_wrong");
    expect(state("workspace-api", "ws-failed-use").lastUsedAt).toBeNull();
  });
});

describe("persistence", () => {
  it("writes only the hash, never the plaintext", () => {
    const plain = mint("workspace-api", "ws-persisted");
    expect(fs.readFileSync(`${ROOT}/.credentials.json`, "utf8")).not.toContain(plain);
  });

  it("denies rather than throws when a stored hash is the wrong length", () => {
    // timingSafeEqual throws on a length mismatch, which a truncated or hand-edited store can
    // produce. That must fail closed, not crash the auth path with a 500. Reaching into the
    // singleton is deliberate: the length guard is unreachable through the public API, and it is
    // exactly the branch a corrupted file would hit in production.
    const plain = mint("workspace-api", "ws-corrupt");
    const singletons = (global as typeof global & { __singletons: Record<string, unknown> }).__singletons;
    const records = singletons.credentials as Record<string, { hash: string }>;
    records["workspace-api:ws-corrupt"].hash = "deadbeef"; // valid hex, wrong length

    expect(() => validate("workspace-api", "ws-corrupt", plain)).not.toThrow();
    expect(validate("workspace-api", "ws-corrupt", plain)).toBe(false);
  });
});

describe("subject rules", () => {
  it("rejects a subject on the instance-wide platform credential", () => {
    expect(() => state("platform", "ws-1")).toThrow(/instance-wide/);
  });

  it("rejects a missing workspace id on the per-workspace kinds", () => {
    expect(() => state("workspace-api", null)).toThrow(/requires a workspace id/);
    expect(() => state("workspace-mcp", null)).toThrow(/requires a workspace id/);
  });
});

describe("removeWorkspace", () => {
  it("drops both workspace credentials and leaves the platform token alone", () => {
    const apiKey = mint("workspace-api", "ws-doomed");
    const mcpSecret = mint("workspace-mcp", "ws-doomed");
    const platformToken = mint("platform");

    removeWorkspace("ws-doomed");

    expect(validate("workspace-api", "ws-doomed", apiKey)).toBe(false);
    expect(validate("workspace-mcp", "ws-doomed", mcpSecret)).toBe(false);
    expect(state("workspace-api", "ws-doomed").hasSecret).toBe(false);
    expect(state("workspace-mcp", "ws-doomed").hasSecret).toBe(false);
    expect(validate("platform", null, platformToken)).toBe(true);
  });

  it("is a no-op for a workspace that never had credentials", () => {
    expect(() => removeWorkspace("ws-never-existed")).not.toThrow();
  });
});
