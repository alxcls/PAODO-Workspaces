// The registry primitive used by the delete operation. A failed registry write
// must leave the in-memory map matching the file on disk rather than dropping the workspace only in
// memory — which would hide it from the UI until a restart brought it back.
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "./workspaceStore";

const record = (id: string) => ({
  id,
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  maxIterations: 30,
});

describe("WorkspaceStore.deleteWorkspace", () => {
  it("removes the workspace from the registry", async () => {
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [record("w1")], persist });

    await expect(store.deleteWorkspace("w1")).resolves.toBe(true);
    expect(store.getWorkspace("w1")).toBeUndefined();
    expect(persist).toHaveBeenCalledWith([]);
  });

  it("does nothing when the registry entry is already gone", async () => {
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [], persist });

    await expect(store.deleteWorkspace("ghost")).resolves.toBe(false);
    // Nothing to persist: the registry did not change.
    expect(persist).not.toHaveBeenCalled();
  });

  it("restores the workspace when the registry write fails, keeping memory and disk in agreement", async () => {
    const failure = new Error("disk full");
    const store = new WorkspaceStore({
      load: () => [record("w1")],
      persist: () => {
        throw failure;
      },
    });

    await expect(store.deleteWorkspace("w1")).rejects.toThrow(failure);
    // Still listed, matching the unchanged file on disk — so the delete stays retryable instead of
    // the workspace vanishing from the UI and reappearing on the next restart.
    expect(store.getWorkspace("w1")?.id).toBe("w1");
  });

  it("is idempotent: deleting twice completes without error", async () => {
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [record("w1")], persist });

    await expect(store.deleteWorkspace("w1")).resolves.toBe(true);
    await expect(store.deleteWorkspace("w1")).resolves.toBe(false);
  });
});
