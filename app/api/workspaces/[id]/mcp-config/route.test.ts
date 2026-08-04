// Route-level coverage for MCP configuration validation and persistence boundaries.
//
// credentialStore is the only thing mocked for writes, because the credential is the only thing this
// endpoint writes; the store and skillStore are stubbed purely as read sources for the exposed set.
// Asserting the credential kind is part of the point — "workspace-mcp" is what keeps this endpoint
// from managing the workspace's agent key or the instance-wide CLI token.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha" },
  state: { enabled: false, hasKey: false, createdAt: null as string | null, lastUsedAt: null as string | null },
  setEnabled: vi.fn(),
  mint: vi.fn(() => "mcp_new"),
  revoke: vi.fn(),
  loadSkills: vi.fn(async () => [
    { id: "read_orders", description: "Read orders" },
    { id: "create_order", description: "Create an order" },
  ]),
}));

vi.mock("@/lib/api/guards", () => ({
  requireWorkspace: () => h.workspace,
}));
vi.mock("@/lib/infra/security/credentialStore", () => ({
  state: () => h.state,
  setEnabled: h.setEnabled,
  mint: h.mint,
  revoke: h.revoke,
}));
vi.mock("@/lib/workspace/skillStore", () => ({ loadSkills: h.loadSkills }));
// The exposed set comes from the shared listWorkspaceSkills operation, which resolves the workspace
// through the store to find its directory — the same set the workspace-details route reports.
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) => (id === h.workspace.id ? h.workspace : undefined),
    listWorkspaces: () => [h.workspace],
  }),
}));

import * as route from "./route";
const { DELETE, GET, PATCH, POST } = route;

const ctx = () => ({ params: Promise.resolve({ id: "ws-1" }) });
const request = (method: string, body?: string) =>
  new Request("http://x/api/workspaces/ws-1/mcp-config", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  }) as never;

beforeEach(() => {
  h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
  h.loadSkills.mockClear();
});

describe("workspace MCP configuration route", () => {
  it("reports every declared skill as exposed, without leaking the secret hash", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasKey: true });
    expect(body).not.toHaveProperty("secretHash");
    expect(body).not.toHaveProperty("hash");
    expect(body.exposedSkills).toEqual([
      { id: "read_orders", description: "Read orders" },
      { id: "create_order", description: "Create an order" },
    ]);
    // The dropped selection fields must not reappear: a client seeing either would render a
    // selection UI over a set it cannot change.
    expect(body).not.toHaveProperty("selectedSkillIds");
    expect(body).not.toHaveProperty("availableSkills");
  });

  // The exposed set is decided by the workspace agent authoring .skills/, so there is nothing for a
  // caller to write. An accidentally reintroduced PUT would be a selection API with no UI behind it.
  it("exposes no PUT handler", () => {
    expect(route).not.toHaveProperty("PUT");
  });

  it("validates PATCH bodies, including malformed JSON", async () => {
    expect((await PATCH(request("PATCH", "not json"), ctx())).status).toBe(400);
    expect((await PATCH(request("PATCH", JSON.stringify({ enabled: "yes" })), ctx())).status).toBe(400);
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(res.status).toBe(200);
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-mcp", "ws-1", true);
  });

  // Exposing the endpoint and issuing the secret that guards it are separate steps, so opening the
  // channel never hands back a read-once secret the caller was not expecting.
  it("opens the channel without minting a secret", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceMcpAccess"],
      values: { workspaceMcpAccess: true },
    });
    expect(h.mint).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves an existing secret alone when the channel is reopened", async () => {
    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceMcpAccess"],
      values: { workspaceMcpAccess: true },
    });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("mints nothing when the channel is closed", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: false })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceMcpAccess"],
      values: { workspaceMcpAccess: false },
    });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-mcp", "ws-1", false);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("generates, rotates and revokes the secret without returning it from GET", async () => {
    expect(await (await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx())).json()).toEqual({
      plain: "mcp_new",
    });

    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    expect(await (await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx())).json()).toEqual({
      plain: "mcp_new",
    });
    expect(h.mint).toHaveBeenCalledWith("workspace-mcp", "ws-1");
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-mcp", "ws-1");
  });

  // Mirrors the API-key route exactly: the MCP secret is a credential like any other, so a closed
  // channel neither blocks issuing its secret nor blocks destroying it.
  it("issues and destroys a secret while MCP access is disabled", async () => {
    h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
    expect((await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx())).status).toBe(200);

    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    expect((await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx())).status).toBe(200);
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-mcp", "ws-1");
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("refuses generation over an existing secret and rotation of a missing one", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const conflict = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, code: "CREDENTIAL_ALREADY_CONFIGURED" });

    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };
    const missing = await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx());
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ ok: false, code: "CREDENTIAL_NOT_CONFIGURED" });

    expect(h.mint).not.toHaveBeenCalled();
  });
});
