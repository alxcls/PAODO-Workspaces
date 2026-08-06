// Route-level coverage for workspace deletion's failure handling. Two invariants:
//   1. The registry entry is removed LAST. Anything that fails before it leaves the workspace
//      listed, so the user can delete again — rather than orphaning a directory, git history, or a
//      running container behind a registry entry that no longer exists (nothing else sweeps them).
//   2. A missing registry entry is NOT a successful deletion. It returns not found and no cleanup
//      runs, so the app and every thin client agree that deleting an already-deleted workspace fails.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  workspace: null as { id: string; name: string; dir: string } | null,
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
vi.mock("@/lib/drives/store", () => ({
  disconnectWorkspace: (id: string) => {
    track("drives");
    return h.disconnectWorkspace(id);
  },
}));
vi.mock("@/lib/agent/network/graph", () => ({
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

import { DELETE } from "./route";

const WORKSPACE_ID = "9841ce91-f521-4ddf-a966-fa5b612167bf";
const ctx = (id = WORKSPACE_ID) => ({ params: Promise.resolve({ id }) });
const request = () => new Request(`http://x/api/workspaces/${WORKSPACE_ID}`, { method: "DELETE" }) as never;

beforeEach(() => {
  h.calls.length = 0;
  h.workspace = { id: WORKSPACE_ID, name: "Alpha", dir: `/data/${WORKSPACE_ID}` };
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
    // `ok` beside `deleted`, so this receipt branches the same way every other mutation's does rather
    // than being the one success a caller has to recognise by name.
    expect(await res.json()).toEqual({ ok: true, deleted: true });
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

  it("returns not found without cleanup when the workspace is already absent", async () => {
    h.workspace = null;

    const res = await DELETE(request(), ctx());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "NOT_FOUND", error: "not found" });
    expect(h.calls).toEqual([]);
  });
});
