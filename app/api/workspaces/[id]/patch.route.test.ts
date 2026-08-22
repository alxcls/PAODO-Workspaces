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
      applied: { name: "Renamed", description: "updated" },
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

  /**
   * A wrong-typed value is a caller error and must answer like one. Each of these used to reach the
   * caller as 500 INTERNAL_ERROR "failed to update workspace": the validators trusted their declared
   * string types, so `.trim()` on a number raised a TypeError, which is not an AppError and so fell
   * through to the unexpected-failure branch. `description` was the sole exception, guarded by hand in
   * this route — which is what made the gap easy to miss, since the one field anyone thought to check
   * was the one that behaved.
   *
   * Status and code are both asserted: a 400 whose body says INTERNAL_ERROR would still tell a
   * programmatic caller its request was fine and the server broke.
   */
  it("rejects a wrong-typed value as a caller error rather than a server failure", async () => {
    const cases: Array<[string, unknown]> = [
      ["name", { name: 123 }],
      ["description", { description: 123 }],
      ["llmProvider", { llmProvider: 5 }],
      ["llmModel", { llmModel: 5 }],
      ["reasoningEffort", { reasoningEffort: 5 }],
    ];

    for (const [field, body] of cases) {
      const res = await patch(body);
      const json = await res.json();
      expect({ field, status: res.status }).toEqual({ field, status: 400 });
      expect({ field, ok: json.ok, internal: json.code === "INTERNAL_ERROR" }).toEqual({
        field,
        ok: false,
        internal: false,
      });
    }
    // Nothing landed on the way to any of those rejections.
    expect({ renames: h.renames, descriptions: h.descriptions }).toEqual({ renames: [], descriptions: [] });
  });

  /**
   * A secret is not a setting. It carries a plaintext value and its own domain scope, and it has
   * endpoints that list and delete it — none of which the settings PATCH can express. The refusal is
   * asserted on three axes because each one is a distinct way a caller could be misled: a code of its
   * own (not the typo branch, which would have a caller retry with a different spelling), a message
   * naming where secrets do live, and an accepted-fields list that never advertises it in the first
   * place.
   */
  it("refuses a secret with its own code and sends the caller to the endpoint that stores one", async () => {
    const res = await patch({ secret: { name: "TOKEN", value: "s3cr3t", domains: ["api.example.com"] } });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      code: "WORKSPACE_SECRET_FORBIDDEN",
      details: { field: "secret", endpoint: `/api/workspaces/${h.workspace.id}/env-vars` },
    });
    expect(body.error).toContain(`/api/workspaces/${h.workspace.id}/env-vars`);
    // The refused value stays out of the answer, whatever else the body says.
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
  });

  it("refuses a secret before applying anything else in the same request", async () => {
    const res = await patch({ name: "Renamed", secret: null });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WORKSPACE_SECRET_FORBIDDEN" });
    expect(h.renames).toEqual([]);
  });

  it("never advertises secret among the accepted fields", async () => {
    for (const res of [await patch({}), await patch({ internet_access: true })]) {
      const { error, details } = await res.json();
      expect(details.acceptedFields).not.toContain("secret");
      expect(error).not.toContain("secret");
    }
  });

  // The generic workspace PATCH is the widest-reaching mutation a programmatic caller has, so it is
  // the one that most needs to be incapable of producing a read-once secret as a side effect. A key
  // comes only from an explicit call to the channel's own route.
  it("reports an opened channel without minting a credential", async () => {
    const res = await patch({ workspaceApiAccess: true });

    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: h.workspace.id,
      applied: { workspaceApiAccess: true },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a reasoning effort the selected provider cannot persist", async () => {
    const res = await patch({ llmProvider: "deepseek", reasoningEffort: "xhigh" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "reasoningEffort for deepseek-v4-flash must be one of: none, low, high, max",
    });
    expect(h.setWorkspaceLlm).not.toHaveBeenCalled();
  });

  it("rejects an inherited model property as a caller error rather than returning 500", async () => {
    const res = await patch({ llmProvider: "scaleway", llmModel: "constructor" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: expect.stringContaining("llmModel for scaleway must be one of:"),
    });
    expect(h.setWorkspaceLlm).not.toHaveBeenCalled();
  });

  it("returns model fields in the same public vocabulary PATCH and GET use", async () => {
    const res = await patch({ llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: h.workspace.id,
      applied: { llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high" },
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
