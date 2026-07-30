// Route-level coverage for MCP configuration validation and persistence boundaries.
//
// Only credentialStore is mocked, because the credential is the only thing this endpoint writes: the
// exposed tool set is read straight from .skills/ and has no store behind it. Asserting the
// credential kind is part of the point — "workspace-mcp" is what keeps this endpoint from managing
// the workspace's agent key or the instance-wide CLI token.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha" },
  state: { enabled: false, hasSecret: false, createdAt: null as string | null, lastUsedAt: null as string | null },
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
  h.state = { enabled: false, hasSecret: false, createdAt: null, lastUsedAt: null };
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
  h.loadSkills.mockClear();
});

describe("workspace MCP configuration route", () => {
  it("reports every declared skill as exposed, without leaking the secret hash", async () => {
    h.state = { enabled: true, hasSecret: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasSecret: true });
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

  it("mints and revokes a secret without returning it from GET", async () => {
    expect(await (await POST(request("POST"), ctx())).json()).toEqual({ plain: "mcp_new" });
    expect(h.mint).toHaveBeenCalledWith("workspace-mcp", "ws-1");
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-mcp", "ws-1");
  });
});
