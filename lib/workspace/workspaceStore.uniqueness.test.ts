// Name-policy and concurrency invariants for WorkspaceStore's create/rename mutations.
//
// Uses a real temp WORKSPACES_ROOT (the established pattern for filesystem-touching store tests, see
// scheduleStore.test.ts) with vi.resetModules() so paths.ts picks up the temp root. The store is
// built with its default scaffold, so createWorkspace lays down real dirs and renameWorkspace does a
// real directory move — letting us assert both the in-memory registry and the on-disk effect.
//
// Errors are asserted on their { name, code } shape rather than `instanceof`, because the store and
// its WorkspaceNameError come from the freshly re-imported module graph, not this file's imports.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "./workspaceStore";

let ROOT: string;
let store: WorkspaceStore;

beforeEach(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wsstore-uniq-"));
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const mod = await import("./workspaceStore");
  store = new mod.WorkspaceStore({ persist: vi.fn() });
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const conflict = { name: "WorkspaceNameError", code: "WORKSPACE_NAME_CONFLICT" };
const invalid = { name: "WorkspaceNameError", code: "WORKSPACE_NAME_INVALID" };

describe("createWorkspace — name policy", () => {
  it("stores the trimmed, normalized name and scaffolds its directory", async () => {
    const ws = await store.createWorkspace("  Invoice Agent  ");
    expect(ws.name).toBe("Invoice Agent");
    expect(fs.existsSync(path.join(ROOT, "Invoice Agent"))).toBe(true);
    expect(store.getWorkspaceByName("Invoice Agent")?.id).toBe(ws.id);
  });

  it("rejects an exact duplicate name", async () => {
    await store.createWorkspace("invoice-agent");
    await expect(store.createWorkspace("invoice-agent")).rejects.toMatchObject(conflict);
    expect(store.listWorkspaces()).toHaveLength(1);
  });

  it("rejects a case-insensitive duplicate", async () => {
    await store.createWorkspace("Sales");
    await expect(store.createWorkspace("sales")).rejects.toMatchObject(conflict);
  });

  it("rejects a Unicode-equivalent duplicate", async () => {
    await store.createWorkspace("café"); // composed é
    await expect(store.createWorkspace("cafe\u0301")).rejects.toMatchObject(conflict); // decomposed e + U+0301
  });

  it("rejects a name containing a path separator", async () => {
    await expect(store.createWorkspace("team/invoices")).rejects.toMatchObject(invalid);
    expect(store.listWorkspaces()).toHaveLength(0);
  });
});

describe("createWorkspace — concurrency", () => {
  it("serializes two concurrent identical creates: exactly one succeeds", async () => {
    const results = await Promise.allSettled([store.createWorkspace("dup"), store.createWorkspace("dup")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject(conflict);
    expect(store.listWorkspaces()).toHaveLength(1);
  });
});

describe("renameWorkspace — name policy", () => {
  it("renames to a new unique name and moves the directory", async () => {
    const ws = await store.createWorkspace("old-name");
    await expect(store.renameWorkspace(ws.id, "new-name")).resolves.toBe(true);
    expect(store.getWorkspace(ws.id)?.name).toBe("new-name");
    expect(fs.existsSync(path.join(ROOT, "new-name"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "old-name"))).toBe(false);
  });

  it("rejects renaming onto another workspace's name and leaves both intact", async () => {
    await store.createWorkspace("alpha");
    const beta = await store.createWorkspace("beta");
    await expect(store.renameWorkspace(beta.id, "alpha")).rejects.toMatchObject(conflict);
    expect(store.getWorkspace(beta.id)?.name).toBe("beta");
    expect(fs.existsSync(path.join(ROOT, "alpha"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "beta"))).toBe(true);
  });

  it("rejects a case-insensitive collision on rename", async () => {
    await store.createWorkspace("alpha");
    const beta = await store.createWorkspace("beta");
    await expect(store.renameWorkspace(beta.id, "ALPHA")).rejects.toMatchObject(conflict);
  });

  it("allows renaming a workspace to its own current name (whitespace only)", async () => {
    const ws = await store.createWorkspace("same");
    await expect(store.renameWorkspace(ws.id, "  same  ")).resolves.toBe(true);
    expect(store.getWorkspace(ws.id)?.name).toBe("same");
  });

  it("rejects an invalid rename target before touching the filesystem", async () => {
    const ws = await store.createWorkspace("valid");
    await expect(store.renameWorkspace(ws.id, "bad/name")).rejects.toMatchObject(invalid);
    expect(fs.existsSync(path.join(ROOT, "valid"))).toBe(true);
  });

  it("returns false for an unknown workspace id", async () => {
    await expect(store.renameWorkspace("does-not-exist", "whatever")).resolves.toBe(false);
  });
});
