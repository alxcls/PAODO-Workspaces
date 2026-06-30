import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the store so we drive reconcile with exact lists, no disk involved.
const perms = vi.hoisted(() => ({ locked: [] as string[], hidden: [] as string[], privileged: [] as string[] }));
vi.mock("./permissionStore", () => ({ getPermissions: () => perms }));

import { reconcileOsPermissions } from "./osLock";

let calls: string[][];
const rootExec = async (cmd: string[]) => {
  calls.push(cmd);
  return { code: 0, stdout: "", stderr: "" };
};

// Finds the state argument passed to the per-path APPLY_SCRIPT for a given absolute path.
function appliedState(absPath: string): string | undefined {
  const call = calls.find((c) => c[0] === "bash" && c[3] === "_" && c[4] === absPath);
  return call?.[5];
}
function hardened(absPath: string): boolean {
  return calls.some((c) => c[0] === "chmod" && c[1] === "3775" && c[2] === absPath);
}

beforeEach(() => {
  calls = [];
  perms.locked = [];
  perms.hidden = [];
  perms.privileged = [];
});

describe("reconcileOsPermissions — full sweep", () => {
  it("normalizes the tree and hardens the workspace root", async () => {
    await reconcileOsPermissions(rootExec, "ws");
    expect(calls).toContainEqual(["chown", "-R", "agent:paodo", "/workspace"]);
    expect(calls).toContainEqual(["chown", "node:paodo", "/workspace"]);
    expect(calls).toContainEqual(["chmod", "3775", "/workspace"]);
  });

  it("applies a locked path and hardens its ancestor dirs", async () => {
    perms.locked = ["a/b/secret.sh"];
    await reconcileOsPermissions(rootExec, "ws");
    expect(appliedState("/workspace/a/b/secret.sh")).toBe("locked");
    expect(hardened("/workspace/a")).toBe(true);
    expect(hardened("/workspace/a/b")).toBe(true);
  });

  it("privilege wins over lock for the same path (precedence)", async () => {
    perms.locked = ["deploy.sh"];
    perms.privileged = ["deploy.sh"];
    await reconcileOsPermissions(rootExec, "ws");
    expect(appliedState("/workspace/deploy.sh")).toBe("privileged");
  });

  it("hidden wins over locked for the same path", async () => {
    perms.locked = ["data.json"];
    perms.hidden = ["data.json"];
    await reconcileOsPermissions(rootExec, "ws");
    expect(appliedState("/workspace/data.json")).toBe("hidden");
  });

  it("does not harden an ancestor that is itself protected", async () => {
    perms.locked = ["dir", "dir/f.txt"];
    await reconcileOsPermissions(rootExec, "ws");
    // "dir" is protected, so it gets its own representation, not the 3775 hardening.
    expect(hardened("/workspace/dir")).toBe(false);
    expect(appliedState("/workspace/dir")).toBe("locked");
  });
});

describe("reconcileOsPermissions — targeted", () => {
  it("applies the protected path only", async () => {
    perms.hidden = ["secret.env"];
    await reconcileOsPermissions(rootExec, "ws", "secret.env");
    expect(appliedState("/workspace/secret.env")).toBe("hidden");
    // no full-tree normalize in targeted mode
    expect(calls).not.toContainEqual(["chown", "-R", "agent:paodo", "/workspace"]);
  });

  it("normalizes a path that is no longer protected", async () => {
    await reconcileOsPermissions(rootExec, "ws", "old.txt");
    const normalize = calls.find((c) => c[0] === "bash" && c[3] === "_" && c[4] === "/workspace/old.txt");
    expect(normalize).toBeDefined();
    expect(normalize?.[5]).toBeUndefined(); // NORMALIZE_SCRIPT takes only the path, no state arg
  });
});
