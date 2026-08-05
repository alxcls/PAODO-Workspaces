import { describe, expect, it, vi } from "vitest";
import { deleteWorkspace, type WorkspaceDeleteDeps } from "./workspaceDelete";

const workspace = { id: "ws-1", name: "Alpha", dir: "/private/alpha" };

function deps(overrides: Partial<WorkspaceDeleteDeps> = {}): WorkspaceDeleteDeps {
  return {
    registry: {
      getWorkspace: () => workspace,
      deleteWorkspace: async () => true,
    },
    cleanupGroups: [],
    log: { debug: vi.fn(), error: vi.fn() },
    audit: { info: vi.fn() },
    ...overrides,
  };
}

describe("workspace deletion policy", () => {
  it("runs cleanup groups in order, permits concurrency within a group, and deletes the registry last", async () => {
    const calls: string[] = [];
    let releaseParallel!: () => void;
    const parallelGate = new Promise<void>((resolve) => {
      releaseParallel = resolve;
    });
    const d = deps({
      registry: {
        getWorkspace: () => workspace,
        deleteWorkspace: async () => {
          calls.push("registry");
          return true;
        },
      },
      cleanupGroups: [
        [{ name: "first", run: () => calls.push("first") }],
        [
          {
            name: "parallel-a",
            run: async () => {
              calls.push("parallel-a:start");
              await parallelGate;
              calls.push("parallel-a:end");
            },
          },
          {
            name: "parallel-b",
            run: () => {
              calls.push("parallel-b");
              releaseParallel();
            },
          },
        ],
        [{ name: "last", run: () => calls.push("last") }],
      ],
    });

    await expect(deleteWorkspace("ws-1", d)).resolves.toEqual({ deleted: true });
    expect(calls).toEqual(["first", "parallel-a:start", "parallel-b", "parallel-a:end", "last", "registry"]);
  });

  it("returns null without running cleanup for an unknown workspace", async () => {
    const cleanup = vi.fn();
    const d = deps({
      registry: { getWorkspace: () => undefined, deleteWorkspace: vi.fn() },
      cleanupGroups: [[{ name: "must-not-run", run: cleanup }]],
    });

    await expect(deleteWorkspace("missing", d)).resolves.toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    expect(d.registry.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("stops before registry deletion when a cleanup stage fails", async () => {
    const deleteRegistry = vi.fn();
    const failure = new Error("cleanup failed");
    const d = deps({
      registry: { getWorkspace: () => workspace, deleteWorkspace: deleteRegistry },
      cleanupGroups: [[{ name: "broken", run: () => Promise.reject(failure) }]],
    });

    await expect(deleteWorkspace("ws-1", d)).rejects.toBe(failure);
    expect(deleteRegistry).not.toHaveBeenCalled();
    expect(d.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "broken", err: failure }),
      expect.any(String),
    );
  });
});
