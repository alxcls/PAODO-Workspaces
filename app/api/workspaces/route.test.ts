// POST /api/workspaces is the only create path; these tests pin its HTTP contract for the name
// policy: a duplicate name is a 409 and a malformed name a 400, each with a machine-readable `code`,
// so the UI can surface the reason instead of silently swallowing a generic 500. The store itself is
// faked — its uniqueness/validation logic is covered in workspaceStore.uniqueness.test.ts; here we
// only assert the route maps a thrown WorkspaceNameError to the right status via guards.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceNameError } from "@/lib/workspace/workspaceName";

const store = { createWorkspace: vi.fn(), listWorkspaces: vi.fn() };
vi.mock("@/lib/infra/services", () => ({ getStore: () => store }));

import { GET, POST } from "./route";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://x/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  store.createWorkspace.mockReset();
  store.listWorkspaces.mockReset().mockReturnValue([]);
});

describe("GET /api/workspaces — shared UI and CLI collection", () => {
  it("returns the trigger-neutral workspace summary", async () => {
    store.listWorkspaces.mockReturnValue([
      {
        id: "w1",
        name: "alpha",
        dir: "/private/w1",
        createdAt: new Date("2026-01-01"),
        description: "shared",
        maxIterations: 30,
        maxRunMinutes: 20,
        internetAccess: false,
      },
    ]);
    const response = await GET();
    expect(await response.json()).toEqual([
      {
        id: "w1",
        name: "alpha",
        description: "shared",
      },
    ]);
  });
});

describe("POST /api/workspaces — creation & name-policy errors", () => {
  it("201s and echoes the created workspace", async () => {
    store.createWorkspace.mockResolvedValue({ id: "w1", name: "alpha", createdAt: new Date("2026-01-01") });
    const res = await post({ name: "  alpha  " });
    expect(res.status).toBe(201);
    expect(store.createWorkspace).toHaveBeenCalledWith("alpha");
    expect(await res.json()).toEqual({ id: "w1", name: "alpha", description: "" });
  });

  it("400s on a missing or blank name without calling the store", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ name: "   " })).status).toBe(400);
    expect(store.createWorkspace).not.toHaveBeenCalled();
  });

  it("409s with WORKSPACE_NAME_CONFLICT on a duplicate name", async () => {
    store.createWorkspace.mockRejectedValue(new WorkspaceNameError("WORKSPACE_NAME_CONFLICT", "taken"));
    const res = await post({ name: "alpha" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "WORKSPACE_NAME_CONFLICT", error: "taken" });
  });

  it("400s with WORKSPACE_NAME_INVALID on a malformed name", async () => {
    store.createWorkspace.mockRejectedValue(new WorkspaceNameError("WORKSPACE_NAME_INVALID", "bad"));
    const res = await post({ name: "team/invoices" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "WORKSPACE_NAME_INVALID" });
  });

  it("500s on an unexpected (non-name) error", async () => {
    store.createWorkspace.mockRejectedValue(new Error("disk full"));
    const res = await post({ name: "alpha" });
    expect(res.status).toBe(500);
  });
});
