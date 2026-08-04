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
    id: "ws-1",
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
  }),
}));
vi.mock("@/lib/infra/security/credentialStore", () => ({
  state: () => ({ enabled: false, hasSecret: false, createdAt: null, lastUsedAt: null }),
  setEnabled: vi.fn(),
  mint: vi.fn(() => "pak_new"),
  removeWorkspace: vi.fn(),
}));

import { PATCH } from "./route";

const ctx = (id = "ws-1") => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = "ws-1") =>
  PATCH(
    new Request("http://x/api/workspaces/ws-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    ctx(id),
  );

beforeEach(() => {
  h.renames = [];
  h.descriptions = [];
});

describe("workspace update body contract", () => {
  it("rejects an unknown field and names the accepted ones", async () => {
    const res = await patch({ internet_access: true });
    expect(res.status).toBe(400);
    const { error } = await res.json();
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
      workspaceId: "ws-1",
      applied: ["name", "description"],
      warnings: [],
    });
    expect(h.renames).toEqual(["Renamed"]);
    expect(h.descriptions).toEqual(["updated"]);
  });

  it("includes a credential minted by the write and prevents receipt caching", async () => {
    const res = await patch({ workspaceApiAccess: true });

    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceApiAccess"],
      warnings: [],
      credentials: { workspaceApiKey: "pak_new" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports an unknown workspace as not found", async () => {
    expect((await patch({ name: "Renamed" }, "missing")).status).toBe(404);
  });
});
