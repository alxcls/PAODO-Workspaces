// Route-level coverage for the internet-access toggle's failure-handling. The registry, the proxy
// policy and the workspace's network are one security boundary, so any step that cannot be
// confirmed rolls the whole change back rather than reporting a half-applied boundary.
//
// The network is rebuilt around a container that keeps running — see applyInternetAccess. This used
// to stop the container instead, which cascaded into a full recreate and destroyed everything the
// agent had installed, so the toggle must never touch the container itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", internetAccess: false },
  setWorkspaceInternetAccess: vi.fn(),
  setInternetAccessPolicy: vi.fn(),
  applyInternetAccess: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/guards", () => ({
  requireWorkspace: () => h.workspace,
}));
vi.mock("@/lib/infra/workspace/registry", () => ({
  setWorkspaceInternetAccess: h.setWorkspaceInternetAccess,
}));
vi.mock("@/lib/infra/proxy/internetAccessPolicy", () => ({
  setInternetAccessPolicy: h.setInternetAccessPolicy,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: () => h.workspace,
    setWorkspaceInternetAccess: h.setWorkspaceInternetAccess,
  }),
  getContainers: () => ({ applyInternetAccess: h.applyInternetAccess }),
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
  h.setWorkspaceInternetAccess.mockReset().mockImplementation((_id: string, enabled: boolean) => {
    h.workspace.internetAccess = enabled;
    return true;
  });
  h.setInternetAccessPolicy.mockReset();
  h.applyInternetAccess.mockReset().mockImplementation(async () => {});
});

describe("PATCH /api/workspaces/[id]/internet-access", () => {
  it("rejects a non-boolean body with the shared error envelope", async () => {
    const res = await PATCH(request({ enabled: "yes" }), ctx());
    expect(res.status).toBe(400);
    // The envelope, not a bare { error }: a programmatic caller branches on `code`, and the message
    // is the shared validator's, so this route and a workspace PATCH refuse identically.
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "internetAccess must be a boolean",
    });
    expect(h.setWorkspaceInternetAccess).not.toHaveBeenCalled();
  });

  it("rejects a malformed body instead of throwing out of the handler", async () => {
    const malformed = new Request("http://x/api/workspaces/ws-1/internet-access", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }) as never;
    const res = await PATCH(malformed, ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(h.setWorkspaceInternetAccess).not.toHaveBeenCalled();
  });

  it("toggles the store and the policy file, and applies the new policy to the network", async () => {
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { internetAccess: true },
    });
    expect(h.setWorkspaceInternetAccess).toHaveBeenCalledWith("ws-1", true);
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true);
    // Carries the new value, so the network is rebuilt with the right --internal flag directly
    // rather than being left for a later container bring-up to reconcile.
    expect(h.applyInternetAccess).toHaveBeenCalledWith("ws-1", true);
  });

  it("rolls back the store field when the policy-file write fails", async () => {
    h.setInternetAccessPolicy.mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, code: "WORKSPACE_UPDATE_FAILED" });
    // Called once to set true, once to roll back to the previous value (false).
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(2, "ws-1", false);
    expect(h.applyInternetAccess).not.toHaveBeenCalled();
  });

  it("rolls back and fails when the network cannot be rebuilt", async () => {
    h.applyInternetAccess.mockImplementation(async () => {
      throw new Error("docker daemon unreachable");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_FAILED",
      error: "failed to apply internet-access setting",
    });
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(2, "ws-1", false);
    expect(h.setInternetAccessPolicy).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setInternetAccessPolicy).toHaveBeenNthCalledWith(2, "ws-1", false);
  });
});
