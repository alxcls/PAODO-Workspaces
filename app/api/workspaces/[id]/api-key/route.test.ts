// Route-level coverage for the workspace agent API key. The credential kind is part of what is being
// asserted: "workspace-api" is what keeps this endpoint from touching the workspace's MCP secret or
// the instance-wide CLI token.
//
// The behaviour worth pinning here is that opening the channel is sufficient — it mints the first key
// and hands it back, because the store keeps only a hash and this response is the one chance to read
// it — while reopening a channel that already has a key leaves that key working.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha", internetAccess: false },
  state: { enabled: false, hasSecret: false, createdAt: null as string | null, lastUsedAt: null as string | null },
  setEnabled: vi.fn(),
  mint: vi.fn(() => "pak_new"),
  revoke: vi.fn(),
  found: true,
}));

vi.mock("@/lib/api/guards", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireWorkspace: () => (h.found ? h.workspace : NextResponse.json({ error: "not found" }, { status: 404 })),
  };
});
vi.mock("@/lib/infra/security/credentialStore", () => ({
  state: () => h.state,
  setEnabled: h.setEnabled,
  mint: h.mint,
  revoke: h.revoke,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) => (h.found && id === h.workspace.id ? h.workspace : undefined),
    listWorkspaces: () => [h.workspace],
  }),
}));

import { DELETE, GET, PATCH, POST } from "./route";

const ctx = (id = "ws-1") => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: string) =>
  new Request("http://x/api/workspaces/ws-1/api-key", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  }) as never;

beforeEach(() => {
  h.state = { enabled: false, hasSecret: false, createdAt: null, lastUsedAt: null };
  h.found = true;
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
});

describe("workspace API key route", () => {
  it("reports channel state without leaking the secret hash", async () => {
    h.state = { enabled: true, hasSecret: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasSecret: true });
    expect(body).not.toHaveProperty("hash");
    expect(body).not.toHaveProperty("plain");
  });

  it("validates PATCH bodies, including malformed JSON", async () => {
    const malformed = await PATCH(request("PATCH", "not json"), ctx());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    const invalid = await PATCH(request("PATCH", JSON.stringify({ enabled: "yes" })), ctx());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("mints and returns the first key when the channel is opened", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({ ok: true, plain: "pak_new" });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", true);
    expect(h.mint).toHaveBeenCalledWith("workspace-api", "ws-1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Rotating on every toggle would invalidate a key that agents already hold.
  it("leaves an existing key alone when the channel is reopened", async () => {
    h.state = { enabled: false, hasSecret: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({ ok: true });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("mints nothing when the channel is closed", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: false })), ctx());
    expect(await res.json()).toEqual({ ok: true });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", false);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("rotates and revokes the key explicitly", async () => {
    expect(await (await POST(request("POST"), ctx())).json()).toEqual({ plain: "pak_new" });
    expect(h.mint).toHaveBeenCalledWith("workspace-api", "ws-1");
    expect((await DELETE(request("DELETE"), ctx())).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-api", "ws-1");
  });

  it("returns the public error contract when credential persistence fails", async () => {
    h.mint.mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    const response = await POST(request("POST"), ctx());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "credential operation failed",
    });
  });

  // Without the workspace guard a mistyped id would mint a key against a workspace that does not
  // exist, leaving an orphan credential record nothing ever cleans up.
  it("refuses every verb for an unknown workspace, minting nothing", async () => {
    h.found = false;
    for (const call of [
      PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx("missing")),
      POST(request("POST"), ctx("missing")),
      DELETE(request("DELETE"), ctx("missing")),
    ]) {
      expect((await call).status).toBe(404);
    }
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });
});
