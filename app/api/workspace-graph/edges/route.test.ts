// The per-edge half of the graph API, whose reason to exist is what it does not accept: no positions,
// so a caller with no canvas cannot erase a layout. This pins the public boundary — the statuses, the
// feature flag, and that a refusal from the operation reaches the caller as its own code, not a 500.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/appError";

const h = vi.hoisted(() => ({
  connectWorkspaces: vi.fn(),
  disconnectWorkspaces: vi.fn(),
}));

vi.mock("@/lib/operations/graph/connect", () => ({
  connectWorkspaces: h.connectWorkspaces,
  disconnectWorkspaces: h.disconnectWorkspaces,
}));

import { DELETE, POST } from "./route";

const EDGE = { id: "call_9b2f0f4e-0000-4000-8000-000000000000", source: "ws-1", target: "ws-2" };

const post = (body: unknown) =>
  new Request("http://x/api/workspace-graph/edges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

const del = (body: unknown) =>
  new Request("http://x/api/workspace-graph/edges", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  delete process.env.GRAPH_ENABLED;
  h.connectWorkspaces.mockReset().mockReturnValue(EDGE);
  h.disconnectWorkspaces.mockReset().mockReturnValue({ deleted: true });
});

afterEach(() => {
  delete process.env.GRAPH_ENABLED;
});

describe("POST /api/workspace-graph/edges", () => {
  it("answers 201 with the edge, under the id the store minted", async () => {
    const response = await POST(post({ source: "ws-1", target: "ws-2" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(EDGE);
    expect(h.connectWorkspaces).toHaveBeenCalledWith({ source: "ws-1", target: "ws-2" });
  });

  it("relays the operation's own refusal rather than reporting a server fault", async () => {
    h.connectWorkspaces.mockImplementation(() => {
      throw new AppError("INVALID_REQUEST", "a workspace cannot call itself", { field: "target" });
    });

    const response = await POST(post({ source: "ws-1", target: "ws-1" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      error: "a workspace cannot call itself",
    });
  });

  it("reports an unexpected failure as a 500 that says nothing was persisted", async () => {
    h.connectWorkspaces.mockImplementation(() => {
      throw new Error("disk full");
    });

    const response = await POST(post({ source: "ws-1", target: "ws-2" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
  });
});

describe("DELETE /api/workspace-graph/edges", () => {
  it("answers 200 with what happened", async () => {
    const response = await DELETE(del({ connectionId: EDGE.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("passes an id already gone back as deleted:false, not as a failure", async () => {
    h.disconnectWorkspaces.mockReturnValue({ deleted: false });

    const response = await DELETE(del({ connectionId: EDGE.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: false });
  });
});

// The flag turns the whole feature off, so neither method may be the one route that still writes to it.
describe("with the graph feature disabled", () => {
  beforeEach(() => {
    process.env.GRAPH_ENABLED = "false";
  });

  it("answers 404 on both methods without reaching the store", async () => {
    for (const response of [
      await POST(post({ source: "ws-1", target: "ws-2" })),
      await DELETE(del({ connectionId: EDGE.id })),
    ]) {
      expect(response.status).toBe(404);
    }
    expect(h.connectWorkspaces).not.toHaveBeenCalled();
    expect(h.disconnectWorkspaces).not.toHaveBeenCalled();
  });
});
