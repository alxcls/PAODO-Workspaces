// The document half of the graph API. Pins the public boundary: the statuses, and that a refusal
// reaches the caller under its own code — a 500 would tell the editor to retry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/appError";

const h = vi.hoisted(() => ({
  getGraph: vi.fn(),
  saveWorkspaceGraph: vi.fn(),
}));

vi.mock("@/lib/agent/graph", () => ({ getGraph: h.getGraph }));

vi.mock("@/lib/operations/graph/save", () => ({ saveWorkspaceGraph: h.saveWorkspaceGraph }));

import { GET, PUT } from "./route";

const GRAPH = {
  edges: [{ id: "call_9b2f0f4e-0000-4000-8000-000000000000", source: "ws-1", target: "ws-2" }],
  positions: { "ws-1": { col: 0, row: 0 } },
};

const put = (body: unknown) =>
  new Request("http://x/api/workspace-graph", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.getGraph.mockReset().mockReturnValue(GRAPH);
  h.saveWorkspaceGraph.mockReset().mockReturnValue(GRAPH);
});

describe("GET /api/workspace-graph", () => {
  it("answers with the stored document", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(GRAPH);
  });
});

describe("PUT /api/workspace-graph", () => {
  // Not just `ok`: a caller that kept its own id would resend it and be given another every save.
  it("answers with the graph as stored, under the ids the store minted", async () => {
    const response = await PUT(put({ edges: GRAPH.edges, positions: GRAPH.positions }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...GRAPH });
    expect(h.saveWorkspaceGraph).toHaveBeenCalledWith({ edges: GRAPH.edges, positions: GRAPH.positions });
  });

  it("relays a dangling edge as the operation's own 404, not as a server fault", async () => {
    h.saveWorkspaceGraph.mockImplementation(() => {
      throw new AppError("NOT_FOUND", "callee workspace not found", { field: "edges[0].target" });
    });

    const response = await PUT(put({ edges: [{ source: "ws-1", target: "gone" }] }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      error: "callee workspace not found",
      details: { field: "edges[0].target" },
    });
  });

  it("relays a cycle as a 400 the user can act on", async () => {
    h.saveWorkspaceGraph.mockImplementation(() => {
      throw new AppError("INVALID_REQUEST", "Graph contains a cycle — only DAGs are allowed.");
    });

    const response = await PUT(put({ edges: GRAPH.edges }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("reports an unexpected failure as a 500", async () => {
    h.saveWorkspaceGraph.mockImplementation(() => {
      throw new Error("disk full");
    });

    const response = await PUT(put({ edges: GRAPH.edges }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
  });

  it("refuses a body that is not an object without reaching the operation", async () => {
    const response = await PUT(
      new Request("http://x/api/workspace-graph", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(h.saveWorkspaceGraph).not.toHaveBeenCalled();
  });
});
