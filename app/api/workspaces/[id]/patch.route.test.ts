// Route-level coverage for the workspace update body contract.
//
// The invariant under test is that a field PATCH does not recognize is a rejection, never a silent
// drop. Ignoring one is worse than any error message: `{name, internet_acces}` would rename the
// workspace, discard the misspelled field, and answer 200 with the typo absent from `applied` — a
// partial change reported as a complete one, which no caller can detect. Both rejections name the
// accepted fields, since a programmatic caller has no form to discover them from.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: {
    id: "9841ce91-f521-4ddf-a966-fa5b612167bf",
    name: "Alpha",
    dir: "/fake/alpha",
    createdAt: new Date("2026-01-02T03:04:05Z"),
    description: "First workspace",
    maxIterations: 30,
    maxRunMinutes: 20,
    internetAccess: false,
  },
  renames: [] as string[],
  descriptions: [] as string[],
  setWorkspaceLlm: vi.fn(() => true),
}));

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) => (id === h.workspace.id ? h.workspace : undefined),
    listWorkspaces: () => [h.workspace],
    renameWorkspace: async (_id: string, name: string) => {
      h.renames.push(name);
      return true;
    },
    setWorkspaceDescription: (_id: string, description: string) => {
      h.descriptions.push(description);
      return true;
    },
    setWorkspaceLlm: h.setWorkspaceLlm,
  }),
}));
vi.mock("@/lib/infra/security/credentialStore", () => ({
  state: () => ({ enabled: false, hasKey: false, createdAt: null, lastUsedAt: null }),
  setEnabled: vi.fn(),
  mint: vi.fn(() => "pak_new"),
  removeWorkspace: vi.fn(),
}));

import { PATCH } from "./route";

const ctx = (id = h.workspace.id) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = h.workspace.id) =>
  PATCH(
    new Request(`http://x/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    ctx(id),
  );

beforeEach(() => {
  h.renames = [];
  h.descriptions = [];
  h.setWorkspaceLlm.mockClear();
});

describe("workspace update body contract", () => {
  it("rejects an unknown field and names the accepted ones", async () => {
    const res = await patch({ internet_access: true });
    expect(res.status).toBe(400);
    const { ok, code, error, details } = await res.json();
    expect({ ok, code }).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(details).toMatchObject({ fields: ["internet_access"] });
    expect(error).toContain("unknown field(s): internet_access");
    expect(error).toContain("internetAccess");
  });

  // The case an "empty body" check alone would miss entirely, and the reason this is a rejection
  // rather than a tolerated extra key.
  it("applies nothing when a typo accompanies a valid field", async () => {
    const res = await patch({ name: "Renamed", internet_acces: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("internet_acces") });
    expect(h.renames).toEqual([]);
  });

  it("names the accepted fields when nothing was supplied", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("no fields supplied");
    expect(error).toContain("maxRunMinutes");
    // The message this replaced sent a caller off to supply a name it never needed.
    expect(error).not.toContain("name required");
  });

  it("returns only a stable mutation receipt for recognized fields", async () => {
    const res = await patch({ name: "Renamed", description: "updated" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: h.workspace.id,
      applied: ["name", "description"],
      values: { name: "Renamed", description: "updated" },
    });
    expect(h.renames).toEqual(["Renamed"]);
    expect(h.descriptions).toEqual(["updated"]);
  });

  it("rejects oversized descriptions and fractional limits without applying another field", async () => {
    const oversized = await patch({ name: "Must not land", description: "x".repeat(4_001) });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "description cannot exceed 4000 characters",
    });

    const fractional = await patch({ name: "Must not land", maxIterations: 2.5 });
    expect(fractional.status).toBe(400);
    expect(await fractional.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "maxIterations must be an integer between 1 and 500",
    });
    expect(h.renames).toEqual([]);
  });

  // The generic workspace PATCH is the widest-reaching mutation a programmatic caller has, so it is
  // the one that most needs to be incapable of producing a read-once secret as a side effect. A key
  // comes only from an explicit call to the channel's own route.
  it("reports an opened channel without minting a credential", async () => {
    const res = await patch({ workspaceApiAccess: true });

    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: h.workspace.id,
      applied: ["workspaceApiAccess"],
      values: { workspaceApiAccess: true },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a reasoning effort the selected provider cannot persist", async () => {
    const res = await patch({ llmProvider: "deepseek", reasoningEffort: "high" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "reasoningEffort is not supported for deepseek",
      details: { field: "reasoningEffort", provider: "deepseek" },
    });
    expect(h.setWorkspaceLlm).not.toHaveBeenCalled();
  });

  it("returns model fields in the same public vocabulary PATCH and GET use", async () => {
    const res = await patch({ llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: h.workspace.id,
      applied: ["llmProvider", "llmModel", "reasoningEffort"],
      values: { llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high" },
    });
  });

  it("reports an unknown workspace as not found", async () => {
    expect((await patch({ name: "Renamed" }, "11111111-1111-1111-1111-111111111111")).status).toBe(404);
  });

  it("rejects a non-canonical workspace id before invoking the update operation", async () => {
    const res = await patch({ name: "Renamed" }, h.workspace.id.toUpperCase());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      details: { field: "workspaceId" },
    });
    expect(h.renames).toEqual([]);
  });
});
