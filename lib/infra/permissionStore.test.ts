import { describe, it, expect, beforeEach, vi } from "vitest";

// Redirect the store's on-disk location to an isolated tmp dir so tests never touch real workspaces.
const TMP = vi.hoisted(() => {
  const os = require("os");
  const path = require("path");
  return path.join(os.tmpdir(), `paodo-perm-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
});
vi.mock("./paths", () => ({ WORKSPACES_ROOT: TMP }));

import { setControl, getPermissions, removePath, isLocked, isPrivileged, isHidden, normalizePermPath, _resetPermissionCache } from "./permissionStore";

const WS = "ws_test";

beforeEach(() => {
  _resetPermissionCache();
});

describe("normalizePermPath", () => {
  it("canonicalizes and rejects traversal/absolute paths", () => {
    expect(normalizePermPath("./a/b.txt")).toBe("a/b.txt");
    expect(normalizePermPath("a/b/")).toBe("a/b");
    expect(normalizePermPath("../escape")).toBeNull();
    expect(normalizePermPath("/etc/passwd")).toBeNull();
    expect(normalizePermPath(".")).toBeNull();
  });
});

describe("permission coupling", () => {
  it("privilege implies lock", () => {
    setControl(WS, "deploy.sh", "privilege", true);
    expect(isPrivileged(WS, "deploy.sh")).toBe(true);
    expect(isLocked(WS, "deploy.sh")).toBe(true);
  });

  it("revoking privilege keeps the lock", () => {
    setControl(WS, "deploy.sh", "privilege", true);
    setControl(WS, "deploy.sh", "privilege", false);
    expect(isPrivileged(WS, "deploy.sh")).toBe(false);
    expect(isLocked(WS, "deploy.sh")).toBe(true);
  });

  it("unlocking revokes privilege ([RW] + [P] is invalid)", () => {
    setControl(WS, "deploy.sh", "privilege", true);
    setControl(WS, "deploy.sh", "lock", false);
    expect(isLocked(WS, "deploy.sh")).toBe(false);
    expect(isPrivileged(WS, "deploy.sh")).toBe(false);
  });

  it("hidden is independent of lock/privilege", () => {
    setControl(WS, "secret.env", "hide", true);
    expect(isHidden(WS, "secret.env")).toBe(true);
    expect(isLocked(WS, "secret.env")).toBe(false);
    setControl(WS, "secret.env", "lock", true);
    expect(isHidden(WS, "secret.env")).toBe(true);
    expect(isLocked(WS, "secret.env")).toBe(true);
    setControl(WS, "secret.env", "lock", false);
    expect(isHidden(WS, "secret.env")).toBe(true); // unlock did not touch hidden
  });

  it("stores normalized keys and is idempotent", () => {
    setControl(WS, "./dir/a.txt", "lock", true);
    setControl(WS, "dir/a.txt", "lock", true);
    expect(getPermissions(WS).locked).toEqual(["dir/a.txt"]);
  });
});

describe("removePath", () => {
  it("drops a path from every list", () => {
    setControl(WS, "x.sh", "privilege", true);
    setControl(WS, "x.sh", "hide", true);
    removePath(WS, "x.sh");
    const p = getPermissions(WS);
    expect(p.locked).not.toContain("x.sh");
    expect(p.hidden).not.toContain("x.sh");
    expect(p.privileged).not.toContain("x.sh");
  });
});

describe("persistence", () => {
  it("round-trips through disk", () => {
    setControl(WS, "keep.txt", "lock", true);
    _resetPermissionCache(); // force a fresh read from disk
    expect(isLocked(WS, "keep.txt")).toBe(true);
  });
});
