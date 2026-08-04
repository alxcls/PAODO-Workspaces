// Route-level coverage for workspace deletion's failure handling. Two invariants:
//   1. The registry entry is removed LAST. Anything that fails before it leaves the workspace
//      listed, so the user can delete again — rather than orphaning a directory, git history, or a
//      running container behind a registry entry that no longer exists (nothing else sweeps them).
//   2. Deleting is idempotent. A missing registry entry means "finish an interrupted delete", not
//      "nothing to do", so every id-keyed stage still runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  workspace: null as { id: string; name: string; dir: string } | null,
  existsSync: vi.fn(() => true),
  deleteWorkspace: vi.fn(async (_id: string) => true),
  disconnectWorkspace: vi.fn(),
  removeWorkspaceFromGraph: vi.fn(),
  removeWorkspaceCredentials: vi.fn(),
  removeContainer: vi.fn(async (_id: string) => {}),
  deleteWorkspaceDir: vi.fn(async (_dir: string) => {}),
  deleteRepo: vi.fn(async (_id: string) => {}),
  rm: vi.fn(async () => {}),
}));

// Each mock records its stage so the test can assert ordering, not just that it was called.
const track = (stage: string) => h.calls.push(stage);

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: () => h.workspace,
    deleteWorkspace: async (id: string) => {
      track("registry");
      return h.deleteWorkspace(id);
    },
  }),
  getContainers: () => ({
    remove: async (id: string) => {
      track("container");
      return h.removeContainer(id);
    },
    deleteWorkspaceDir: async (dir: string) => {
      track("directory");
      return h.deleteWorkspaceDir(dir);
    },
  }),
  getVersioning: () => ({
    deleteRepo: async (id: string) => {
      track("version_history");
      return h.deleteRepo(id);
    },
  }),
}));
vi.mock("@/lib/workspace/driveStore", () => ({
  disconnectWorkspace: (id: string) => {
    track("drives");
    return h.disconnectWorkspace(id);
  },
}));
vi.mock("@/lib/workspace/workspaceGraph", () => ({
  removeWorkspaceFromGraph: (id: string) => {
    track("graph");
    return h.removeWorkspaceFromGraph(id);
  },
}));
vi.mock("@/lib/infra/security/credentialStore", () => ({
  removeWorkspace: (id: string) => {
    track("credentials");
    return h.removeWorkspaceCredentials(id);
  },
}));
vi.mock("fs/promises", () => ({ rm: h.rm }));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: h.existsSync,
}));

import { DELETE } from "./route";

const ctx = (id = "ws-1") => ({ params: Promise.resolve({ id }) });
const request = () => new Request("http://x/api/workspaces/ws-1", { method: "DELETE" }) as never;

beforeEach(() => {
  h.calls.length = 0;
  h.workspace = { id: "ws-1", name: "Alpha", dir: "/data/ws-1" };
  h.existsSync.mockReset().mockReturnValue(true);
  h.deleteWorkspace.mockReset().mockResolvedValue(true);
  for (const fn of [
    h.disconnectWorkspace,
    h.removeWorkspaceFromGraph,
    h.removeWorkspaceCredentials,
    h.removeContainer,
    h.deleteWorkspaceDir,
    h.deleteRepo,
    h.rm,
  ]) {
    fn.mockReset();
  }
  h.removeContainer.mockResolvedValue(undefined);
  h.deleteWorkspaceDir.mockResolvedValue(undefined);
  h.deleteRepo.mockResolvedValue(undefined);
  h.rm.mockResolvedValue(undefined);
});

describe("DELETE /api/workspaces/[id]", () => {
  it("removes the registry entry last, after every owned resource", async () => {
    const res = await DELETE(request(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    // The ordering guarantee: whatever else ran, the registry came last.
    expect(h.calls.at(-1)).toBe("registry");
    expect(h.calls).toContain("directory");
    expect(h.calls).toContain("container");
    expect(h.calls).toContain("version_history");
  });

  it("leaves the workspace in the registry when an earlier stage fails, so it can be retried", async () => {
    h.deleteWorkspaceDir.mockRejectedValue(new Error("docker daemon unavailable"));

    const response = await DELETE(request(), ctx());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "failed to delete workspace",
    });

    // The crux: the registry entry survives a failed delete, so the workspace is still listed and
    // the user can delete again. Previously it was removed first and the retry became a no-op.
    expect(h.calls).not.toContain("registry");
    expect(h.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("still cleans up when the registry entry is already gone (resumes an interrupted delete)", async () => {
    h.workspace = null;

    const res = await DELETE(request(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false, resumed: true });
    // Every id-keyed stage runs again; none of them may be skipped just because the entry is gone.
    expect(h.calls).toEqual(expect.arrayContaining(["drives", "graph", "credentials", "container", "version_history"]));
    expect(h.deleteWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("derives the directory from the id when resuming, since the registry no longer records it", async () => {
    h.workspace = null;

    await DELETE(request(), ctx());

    expect(h.deleteWorkspaceDir).toHaveBeenCalledWith(expect.stringContaining("ws-1"));
  });

  it("skips the container-backed directory delete when resuming with no residue on disk", async () => {
    h.workspace = null;
    h.existsSync.mockReturnValue(false);

    await DELETE(request(), ctx());

    expect(h.deleteWorkspaceDir).not.toHaveBeenCalled();
    // The cheap id-keyed stages still run — only the expensive one is conditional.
    expect(h.calls).toContain("registry");
  });

  it("always attempts the directory delete on the normal path, even if it cannot be stat'd", async () => {
    h.existsSync.mockReturnValue(false);

    await DELETE(request(), ctx());

    // A data volume the app cannot stat must never silently skip the delete.
    expect(h.deleteWorkspaceDir).toHaveBeenCalledWith("/data/ws-1");
  });
});
