// The proxy secret is what stops one workspace from assuming another's identity at the credential
// proxy. These pin that a container gets a stable, workspace-specific secret and that verification
// rejects anything but the exact value derived from that workspace's id.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import forge from "node-forge";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ensureCA, deriveProxySecret, verifyProxySecret, signDomainCert } from "./proxyCA";

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

describe("strict existing proxy material", () => {
  it("still provisions a completely fresh data root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "proxy-ca-fresh-test-"));
    expect(() => ensureCA(root, { strictExisting: true })).not.toThrow();
  });

  it("rejects partial existing CA material instead of silently rotating it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "proxy-ca-partial-test-"));
    const dir = path.join(root, ".proxy-ca");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ca.key"), "partial");
    expect(() => ensureCA(root, { strictExisting: true })).toThrow(/incomplete/);
  });

  it("rejects a corrupt existing HMAC key", () => {
    const root = mkdtempSync(path.join(tmpdir(), "proxy-hmac-corrupt-test-"));
    const dir = path.join(root, ".proxy-ca");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "proxy-hmac.key"), "short");
    expect(() => ensureCA(root, { strictExisting: true })).toThrow(/HMAC key is corrupt/);
  });
});

describe("domain cert renewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const notAfter = (pem: string) => forge.pki.certificateFromPem(pem).validity.notAfter.getTime();
  const DAY = 24 * 60 * 60 * 1000;

  it("reuses the cached cert while it is far from expiry", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = signDomainCert("reuse.example.com").cert;
    vi.setSystemTime(Date.now() + 300 * DAY);
    expect(signDomainCert("reuse.example.com").cert).toBe(first);
  });

  it("re-signs the cert before it expires on a long-running proxy", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = signDomainCert("renew.example.com").cert;
    vi.setSystemTime(notAfter(first) - 10 * DAY);
    const renewed = signDomainCert("renew.example.com").cert;
    expect(renewed).not.toBe(first);
    expect(notAfter(renewed)).toBeGreaterThan(Date.now() + 300 * DAY);
  });
});
