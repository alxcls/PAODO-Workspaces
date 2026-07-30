// Route-level coverage for MCP configuration validation and persistence boundaries.
//
// The credential and the skill selection now live in two stores, so this mocks both: credentialStore
// for the secret's lifecycle (shared with the API-key and CLI channels) and mcpSkillStore for the
// published set. Asserting the credential kind is part of the point — "workspace-mcp" is what keeps
// this endpoint from managing the workspace's agent key or the instance-wide CLI token.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha" },
  state: { enabled: false, hasSecret: false, createdAt: null as string | null, lastUsedAt: null as string | null },
  selectedSkillIds: [] as string[],
  setEnabled: vi.fn(),
  mint: vi.fn(() => "mcp_new"),
  revoke: vi.fn(),
  setSelectedSkills: vi.fn(),
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
vi.mock("@/lib/infra/security/mcpSkillStore", () => ({
  getSelectedSkills: () => h.selectedSkillIds,
  setSelectedSkills: h.setSelectedSkills,
}));
vi.mock("@/lib/workspace/skillStore", () => ({ loadSkills: h.loadSkills }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1" }) });
const request = (method: string, body?: string) =>
  new Request("http://x/api/workspaces/ws-1/mcp-config", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  }) as never;

beforeEach(() => {
  h.state = { enabled: false, hasSecret: false, createdAt: null, lastUsedAt: null };
  h.selectedSkillIds = [];
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
  h.setSelectedSkills.mockClear();
  h.loadSkills.mockClear();
});

describe("workspace MCP configuration route", () => {
  it("returns state and available skills without exposing any hash", async () => {
    h.state = { enabled: true, hasSecret: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    h.selectedSkillIds = ["read_orders"];
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasSecret: true, selectedSkillIds: ["read_orders"] });
    expect(body).not.toHaveProperty("secretHash");
    expect(body).not.toHaveProperty("hash");
    expect(body.availableSkills).toEqual([
      { id: "read_orders", description: "Read orders" },
      { id: "create_order", description: "Create an order" },
    ]);
  });

  it("validates PATCH bodies, including malformed JSON", async () => {
    expect((await PATCH(request("PATCH", "not json"), ctx())).status).toBe(400);
    expect((await PATCH(request("PATCH", JSON.stringify({ enabled: "yes" })), ctx())).status).toBe(400);
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(res.status).toBe(200);
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-mcp", "ws-1", true);
  });

  it("mints and revokes a secret without returning it from GET", async () => {
    expect(await (await POST(request("POST"), ctx())).json()).toEqual({ plain: "mcp_new" });
    expect(h.mint).toHaveBeenCalledWith("workspace-mcp", "ws-1");
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-mcp", "ws-1");
  });

  it("validates selected IDs and persists only skills that exist", async () => {
    expect((await PUT(request("PUT", "bad json"), ctx())).status).toBe(400);
    expect((await PUT(request("PUT", JSON.stringify({ selectedSkillIds: ["read_orders", 3] })), ctx())).status).toBe(
      400,
    );
    const res = await PUT(
      request("PUT", JSON.stringify({ selectedSkillIds: ["read_orders", "missing", "read_orders"] })),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(h.setSelectedSkills).toHaveBeenCalledWith("ws-1", ["read_orders", "read_orders"]);
  });
});
