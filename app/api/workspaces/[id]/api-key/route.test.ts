// Route-level coverage for the workspace agent API key. The credential kind is part of what is being
// asserted: "workspace-api" is what keeps this endpoint from touching the workspace's MCP secret or
// the instance-wide CLI token.
//
// The behaviour worth pinning here is that the channel's two axes stay independent: PATCH moves only
// the on/off flag and never produces a key, while POST and DELETE act only on the key and never
// consult the flag — so a key can be issued before the channel opens and destroyed after it closes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha", internetAccess: false },
  state: { enabled: false, hasKey: false, createdAt: null as string | null, lastUsedAt: null as string | null },
  setEnabled: vi.fn(),
  mint: vi.fn(() => "pak_new"),
  revoke: vi.fn(),
  found: true,
}));

vi.mock("@/lib/api/guards", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireWorkspaceId: () => (h.found ? h.workspace : NextResponse.json({ error: "not found" }, { status: 404 })),
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
  h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
  h.found = true;
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
});

describe("workspace API key route", () => {
  it("reports channel state without leaking the secret hash", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasKey: true });
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

  // Opening the channel used to mint its first key and hand back the plaintext. It no longer does:
  // a caller that flips this flag — the UI, the CLI, a script — can no longer be handed a
  // read-once secret it was not expecting and will never see again.
  it("opens the channel without minting a key", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceApiAccess"],
      values: { workspaceApiAccess: true },
    });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", true);
    expect(h.mint).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Rotating on every toggle would invalidate a key that agents already hold.
  it("leaves an existing key alone when the channel is reopened", async () => {
    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceApiAccess"],
      values: { workspaceApiAccess: true },
    });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("mints nothing when the channel is closed", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: false })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["workspaceApiAccess"],
      values: { workspaceApiAccess: false },
    });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", false);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("generates the first key and rotates it afterwards", async () => {
    expect(await (await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx())).json()).toEqual({
      plain: "pak_new",
    });

    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    expect(await (await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx())).json()).toEqual({
      plain: "pak_new",
    });
    expect(h.mint).toHaveBeenCalledWith("workspace-api", "ws-1");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  // The two orders that a channel-enabled precondition used to make impossible. Both matter: issuing
  // first means the channel is never live while the key is in transit to whoever needs it, and
  // revoking a leaked key must never require reopening the channel it leaked from.
  it("issues and destroys a key while the channel is closed", async () => {
    h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
    const generated = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(generated.status).toBe(200);
    expect(await generated.json()).toEqual({ plain: "pak_new" });

    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const rotated = await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx());
    expect(rotated.status).toBe(200);

    const revoked = await DELETE(request("DELETE"), ctx());
    expect(revoked.status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-api", "ws-1");
    // Neither verb touched the other axis.
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  // Revocation is how a leaked key is destroyed, so it answers the same way however often it is asked
  // and whatever state it finds — a caller retrying after a dropped response must not see a failure
  // that suggests the key is still live.
  it("revokes idempotently, including when there is no key", async () => {
    for (const attempt of [1, 2]) {
      const res = await DELETE(request("DELETE"), ctx());
      expect(res.status, `attempt ${attempt}`).toBe(200);
      expect(await res.json()).toEqual({ ok: true, workspaceApiAccess: false, workspaceApiHasKey: false });
    }
    expect(h.revoke).toHaveBeenCalledTimes(2);
  });

  // Revoking the last key leaves the channel open and keyless. The receipt has to say so: reading only
  // `ok: true`, an operator who has just retired a channel walks away believing they closed it, and the
  // workspace goes on reporting workspaceApiAccess: true with nothing behind it.
  //
  // It says so in the workspace projection's words, not the credential store's. `revoke` answering
  // `enabled` while `get` answers `workspaceApiAccess` made one channel look like two things.
  it("reports the open, keyless channel it leaves behind", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };

    const res = await DELETE(request("DELETE"), ctx());

    expect(await res.json()).toEqual({ ok: true, workspaceApiAccess: true, workspaceApiHasKey: false });
    // Closing the channel is the caller's next decision, not a side effect of revoking.
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("refuses rotation when there is no key to replace", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };

    const res = await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "CREDENTIAL_NOT_CONFIGURED" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("requires an explicit generation or rotation operation", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };

    const missing = await POST(request("POST"), ctx());
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  // Without this, a click or a script meant to create a first key would silently replace one that
  // agents are still authenticating with.
  it("refuses generation when a key already exists", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };

    const res = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "CREDENTIAL_ALREADY_CONFIGURED" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("returns the public error contract when credential persistence fails", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };
    h.mint.mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    const response = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
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
      POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx("missing")),
      DELETE(request("DELETE"), ctx("missing")),
    ]) {
      expect((await call).status).toBe(404);
    }
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });
});
