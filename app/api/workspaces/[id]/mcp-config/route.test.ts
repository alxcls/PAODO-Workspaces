// Route-level coverage for MCP configuration validation and persistence boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  limited: null as Response | null,
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha" },
  state: { enabled: false, secretHash: null as string | null, selectedSkillIds: [] as string[] },
  setEnabled: vi.fn(),
  mintSecret: vi.fn(() => "mcp_new"),
  revokeSecret: vi.fn(),
  setSelectedSkills: vi.fn(),
  loadSkills: vi.fn(async () => [
    { id: "read_orders", description: "Read orders" },
    { id: "create_order", description: "Create an order" },
  ]),
}));

vi.mock("@/lib/api/guards", () => ({
  rateLimited: () => h.limited,
  requireWorkspace: () => h.workspace,
}));
vi.mock("@/lib/infra/security/mcpConfigStore", () => ({
  getState: () => h.state,
  setEnabled: h.setEnabled,
  mintSecret: h.mintSecret,
  revokeSecret: h.revokeSecret,
  setSelectedSkills: h.setSelectedSkills,
}));
vi.mock("@/lib/workspace/skillStore", () => ({ loadSkills: h.loadSkills }));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1" }) });
const request = (method: string, body?: string) => new Request("http://x/api/workspaces/ws-1/mcp-config", {
  method, headers: body ? { "content-type": "application/json" } : {}, body,
}) as never;

beforeEach(() => {
  h.limited = null;
  h.state = { enabled: false, secretHash: null, selectedSkillIds: [] };
  h.setEnabled.mockClear(); h.mintSecret.mockClear(); h.revokeSecret.mockClear(); h.setSelectedSkills.mockClear(); h.loadSkills.mockClear();
});

describe("workspace MCP configuration route", () => {
  it("returns state and available skills without exposing the secret hash", async () => {
    h.state = { enabled: true, secretHash: "hashed", selectedSkillIds: ["read_orders"] };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasSecret: true, selectedSkillIds: ["read_orders"] });
    expect(body).not.toHaveProperty("secretHash");
    expect(body.availableSkills).toEqual([{ id: "read_orders", description: "Read orders" }, { id: "create_order", description: "Create an order" }]);
  });

  it("validates PATCH bodies, including malformed JSON", async () => {
    expect((await PATCH(request("PATCH", "not json"), ctx())).status).toBe(400);
    expect((await PATCH(request("PATCH", JSON.stringify({ enabled: "yes" })), ctx())).status).toBe(400);
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(res.status).toBe(200);
    expect(h.setEnabled).toHaveBeenCalledWith("ws-1", true);
  });

  it("mints and revokes a secret without returning it from GET", async () => {
    expect(await (await POST(request("POST"), ctx())).json()).toEqual({ plain: "mcp_new" });
    expect(h.mintSecret).toHaveBeenCalledWith("ws-1");
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revokeSecret).toHaveBeenCalledWith("ws-1");
  });

  it("validates selected IDs and persists only skills that exist", async () => {
    expect((await PUT(request("PUT", "bad json"), ctx())).status).toBe(400);
    expect((await PUT(request("PUT", JSON.stringify({ selectedSkillIds: ["read_orders", 3] })), ctx())).status).toBe(400);
    const res = await PUT(request("PUT", JSON.stringify({ selectedSkillIds: ["read_orders", "missing", "read_orders"] })), ctx());
    expect(res.status).toBe(200);
    expect(h.setSelectedSkills).toHaveBeenCalledWith("ws-1", ["read_orders", "read_orders"]);
  });

  it("short-circuits every operation when rate limited", async () => {
    h.limited = new Response("Too Many Requests", { status: 429 });
    expect((await POST(request("POST"), ctx())).status).toBe(429);
    expect(h.mintSecret).not.toHaveBeenCalled();
  });
});
