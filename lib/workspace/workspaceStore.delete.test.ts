// deleteWorkspace's contract for interrupted deletes. The owned-resource cascade must run even when
// the registry entry is already gone (so a retry can finish the job), and a failed registry write
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
  it("runs the owned-resource cascade and removes the workspace", async () => {
    const onDelete = vi.fn();
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [record("w1")], persist, onDelete });

    await expect(store.deleteWorkspace("w1")).resolves.toBe(true);
    expect(onDelete).toHaveBeenCalledWith("w1");
    expect(store.getWorkspace("w1")).toBeUndefined();
    expect(persist).toHaveBeenCalledWith([]);
  });

  it("still runs the cascade when the registry entry is already gone", async () => {
    const onDelete = vi.fn();
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [], persist, onDelete });

    // Reports false — nothing was in the registry — but the cleanup must still happen, otherwise a
    // delete interrupted after the registry write could never be completed.
    await expect(store.deleteWorkspace("ghost")).resolves.toBe(false);
    expect(onDelete).toHaveBeenCalledWith("ghost");
    // Nothing to persist: the registry did not change.
    expect(persist).not.toHaveBeenCalled();
  });

  it("restores the workspace when the registry write fails, keeping memory and disk in agreement", async () => {
    const failure = new Error("disk full");
    const onDelete = vi.fn();
    const store = new WorkspaceStore({
      load: () => [record("w1")],
      persist: () => {
        throw failure;
      },
      onDelete,
    });

    await expect(store.deleteWorkspace("w1")).rejects.toThrow(failure);
    // Still listed, matching the unchanged file on disk — so the delete stays retryable instead of
    // the workspace vanishing from the UI and reappearing on the next restart.
    expect(store.getWorkspace("w1")?.id).toBe("w1");
  });

  it("is idempotent: deleting twice completes without error", async () => {
    const onDelete = vi.fn();
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [record("w1")], persist, onDelete });

    await expect(store.deleteWorkspace("w1")).resolves.toBe(true);
    await expect(store.deleteWorkspace("w1")).resolves.toBe(false);
    expect(onDelete).toHaveBeenCalledTimes(2);
  });
});
