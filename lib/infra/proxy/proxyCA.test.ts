// The proxy secret is what stops one workspace from assuming another's identity at the credential
// proxy. These pin that a container gets a stable, workspace-specific secret and that verification
// rejects anything but the exact value derived from that workspace's id.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ensureCA, deriveProxySecret, verifyProxySecret } from "./proxyCA";

// ensureCA generates the host-only HMAC key into <dataDir>/.proxy-ca. Point it at a throwaway dir so
// the test never touches the real data/ tree.
beforeAll(() => {
  ensureCA(mkdtempSync(path.join(tmpdir(), "proxy-ca-test-")));
});

describe("proxy secret derivation", () => {
  it("is stable for a given workspace id", () => {
    expect(deriveProxySecret("ws-a")).toBe(deriveProxySecret("ws-a"));
  });

  it("differs between workspaces", () => {
    expect(deriveProxySecret("ws-a")).not.toBe(deriveProxySecret("ws-b"));
  });

  it("is not the workspace id itself (unguessable)", () => {
    expect(deriveProxySecret("ws-a")).not.toContain("ws-a");
    expect(deriveProxySecret("ws-a").length).toBeGreaterThan(32);
  });
});

describe("verifyProxySecret", () => {
  it("accepts the secret derived for the same workspace", () => {
    expect(verifyProxySecret("ws-a", deriveProxySecret("ws-a"))).toBe(true);
  });

  it("rejects another workspace's secret (the spoofing case)", () => {
    expect(verifyProxySecret("ws-a", deriveProxySecret("ws-b"))).toBe(false);
  });

  it("rejects the workspace id used as the secret (old behavior)", () => {
    expect(verifyProxySecret("ws-a", "ws-a")).toBe(false);
    expect(verifyProxySecret("ws-a", "x")).toBe(false);
  });

  it("rejects a missing secret", () => {
    expect(verifyProxySecret("ws-a", undefined)).toBe(false);
    expect(verifyProxySecret("ws-a", "")).toBe(false);
  });
});
