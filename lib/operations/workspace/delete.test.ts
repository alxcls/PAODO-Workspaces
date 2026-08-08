import { describe, expect, it, vi } from "vitest";
import { deleteWorkspace, type WorkspaceDeleteDeps } from "./delete";

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
    deriveWorkspaceDir: (id) => `/private/${id}`,
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

  it("still runs the full cleanup sweep for an unknown workspace, then returns null", async () => {
    const cleanup = vi.fn();
    const deleteRegistry = vi.fn(async () => false);
    const d = deps({
      registry: { getWorkspace: () => undefined, deleteWorkspace: deleteRegistry },
      cleanupGroups: [[{ name: "must-run", run: cleanup }]],
    });

    await expect(deleteWorkspace("missing", d)).resolves.toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(deleteRegistry).toHaveBeenCalledWith("missing");
  });

  it("derives a synthetic target from the id and passes it to every cleanup stage when the registry entry is missing", async () => {
    const run = vi.fn();
    const d = deps({
      registry: { getWorkspace: () => undefined, deleteWorkspace: vi.fn(async () => false) },
      cleanupGroups: [[{ name: "stage", run }]],
      deriveWorkspaceDir: () => "/private/missing",
    });

    await deleteWorkspace("missing", d);

    expect(run).toHaveBeenCalledWith({ id: "missing", name: "missing", dir: "/private/missing" });
  });

  it("logs the started event with resuming: true and a distinct swept event, never workspace_deleted, when the registry entry is missing", async () => {
    const d = deps({
      registry: { getWorkspace: () => undefined, deleteWorkspace: vi.fn(async () => false) },
      cleanupGroups: [],
    });

    await deleteWorkspace("missing", d);

    expect(d.audit.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "workspace_delete_started", resuming: true }),
      expect.any(String),
    );
    expect(d.audit.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "workspace_delete_swept_missing_registry" }),
      expect.any(String),
    );
    expect(d.audit.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "workspace_deleted" }),
      expect.any(String),
    );
  });

  it("stops before registry deletion when a cleanup stage fails while resuming", async () => {
    const deleteRegistry = vi.fn();
    const failure = new Error("cleanup failed");
    const d = deps({
      registry: { getWorkspace: () => undefined, deleteWorkspace: deleteRegistry },
      cleanupGroups: [[{ name: "broken", run: () => Promise.reject(failure) }]],
    });

    await expect(deleteWorkspace("missing", d)).rejects.toBe(failure);
    expect(deleteRegistry).not.toHaveBeenCalled();
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
