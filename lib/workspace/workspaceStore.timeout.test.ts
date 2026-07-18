import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "./workspaceStore";
import { DEFAULT_MAX_RUN_MINUTES } from "./workspaceLimits";

describe("WorkspaceStore maxRunMinutes", () => {
  it("defaults old registry records and persists workspace overrides", () => {
    const persist = vi.fn();
    const store = new WorkspaceStore({
      load: () => [
        {
          id: "w1",
          name: "legacy-workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
          maxIterations: 30,
        },
      ],
      persist,
    });

    expect(store.getWorkspace("w1")?.maxRunMinutes).toBe(DEFAULT_MAX_RUN_MINUTES);
    expect(store.setWorkspaceMaxRunMinutes("w1", 45)).toBe(true);
    expect(store.getWorkspace("w1")?.maxRunMinutes).toBe(45);
    expect(persist).toHaveBeenCalledWith([expect.objectContaining({ id: "w1", maxRunMinutes: 45 })]);
  });

  it("surfaces registry persistence failures after retaining the live update", () => {
    const failure = new Error("disk full");
    const store = new WorkspaceStore({
      load: () => [
        {
          id: "w1",
          name: "workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
          maxIterations: 30,
        },
      ],
      persist: () => {
        throw failure;
      },
    });

    expect(() => store.setWorkspaceMaxRunMinutes("w1", 45)).toThrow(failure);
    expect(store.getWorkspace("w1")?.maxRunMinutes).toBe(45);
  });
});
