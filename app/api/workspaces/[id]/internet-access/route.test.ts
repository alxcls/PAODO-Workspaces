// Route-level coverage for the internet-access toggle's failure-handling: a policy-file write
// failure must roll back the store field (they can never disagree), while a container-stop failure
// must not (the setting is already correctly saved — only the running container hasn't caught up,
// and containerManager's secrets-hash mismatch check self-heals that on the next ensure()).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", internetAccess: false },
  setWorkspaceInternetAccess: vi.fn(),
  setInternetAccessPolicy: vi.fn(),
  stop: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/guards", () => ({
  requireWorkspace: () => h.workspace,
}));
vi.mock("@/lib/workspace/workspaceStore", () => ({
  setWorkspaceInternetAccess: h.setWorkspaceInternetAccess,
}));
vi.mock("@/lib/infra/proxy/internetAccessPolicy", () => ({
  setInternetAccessPolicy: h.setInternetAccessPolicy,
}));
vi.mock("@/lib/infra/services", () => ({
  getContainers: () => ({ stop: h.stop }),
}));

import { PATCH } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1" }) });
const request = (body?: unknown) =>
  new Request("http://x/api/workspaces/ws-1/internet-access", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  h.workspace = { id: "ws-1", name: "Alpha", internetAccess: false };
  h.setWorkspaceInternetAccess.mockClear();
  h.setInternetAccessPolicy.mockReset();
  h.stop.mockReset().mockImplementation(async () => {});
});

describe("PATCH /api/workspaces/[id]/internet-access", () => {
  it("rejects a non-boolean body", async () => {
    const res = await PATCH(request({ enabled: "yes" }), ctx());
    expect(res.status).toBe(400);
    expect(h.setWorkspaceInternetAccess).not.toHaveBeenCalled();
  });

  it("toggles the store, the policy file, and stops the container on success", async () => {
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(200);
    expect(h.setWorkspaceInternetAccess).toHaveBeenCalledWith("ws-1", true);
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true);
    expect(h.stop).toHaveBeenCalledWith("ws-1");
  });

  it("rolls back the store field when the policy-file write fails", async () => {
    h.setInternetAccessPolicy.mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(500);
    // Called once to set true, once to roll back to the previous value (false).
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(2, "ws-1", false);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("keeps the toggle (no rollback) when only the container stop fails", async () => {
    h.stop.mockImplementation(async () => {
      throw new Error("docker daemon unreachable");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, warning: expect.any(String) });
    // Only the initial set — no rollback call for either store or policy.
    expect(h.setWorkspaceInternetAccess).toHaveBeenCalledTimes(1);
    expect(h.setWorkspaceInternetAccess).toHaveBeenCalledWith("ws-1", true);
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true);
  });
});
