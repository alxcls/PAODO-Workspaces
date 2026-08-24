// The document write's half of the contract connect.test.ts pins per edge. The negative case is the
// point: before this, a PUT could put an edge naming no workspace into the store.
import { describe, expect, it, vi } from "vitest";
import { saveWorkspaceGraph, type GraphDocumentDeps } from "./save";
import type { GraphFile } from "@/lib/agent/graph";

const LIVE = ["ws-1", "ws-2", "ws-3"];

const stored: GraphFile = { edges: [], positions: {} };

function deps(overrides: Partial<GraphDocumentDeps> = {}): GraphDocumentDeps {
  return {
    workspaceExists: (workspaceId) => LIVE.includes(workspaceId),
    save: vi.fn(() => stored),
    ...overrides,
  };
}

describe("saving the whole graph document", () => {
  it("passes the edges and positions through in the order they were sent", () => {
    const save = vi.fn(() => stored);
    const positions = { "ws-1": { col: 0, row: 0 } };

    const result = saveWorkspaceGraph(
      { edges: [{ id: "call_a", source: "ws-1", target: "ws-2" }], positions },
      deps({ save }),
    );

    expect(result).toBe(stored);
    expect(save).toHaveBeenCalledWith([{ id: "call_a", source: "ws-1", target: "ws-2" }], positions);
  });

  it("treats an absent document as an empty one rather than refusing it", () => {
    const save = vi.fn(() => stored);

    saveWorkspaceGraph({}, deps({ save }));

    expect(save).toHaveBeenCalledWith([], {});
  });

  // The canvas records which handle an edge was dropped on; dropping an unrecognised field would
  // silently restyle the drawing on every save.
  it("carries fields it has no opinion about through untouched", () => {
    const save = vi.fn(() => stored);
    const edge = { id: "call_a", source: "ws-1", target: "ws-2", sourceHandle: "right", targetHandle: "left" };

    saveWorkspaceGraph({ edges: [edge] }, deps({ save }));

    expect(save).toHaveBeenCalledWith([edge], {});
  });

  // Ids are the store's to mint, but the prefix check deciding whether one survives is a string
  // method, and would fault on undefined.
  it("accepts an edge with no id, leaving the store to mint one", () => {
    const save = vi.fn(() => stored);

    saveWorkspaceGraph({ edges: [{ source: "ws-1", target: "ws-2" }] }, deps({ save }));

    expect(save).toHaveBeenCalledWith([{ id: "", source: "ws-1", target: "ws-2" }], {});
  });
});

describe("edges naming a workspace that does not exist", () => {
  it.each([
    ["an unknown caller", { source: "gone", target: "ws-2" }, "caller workspace not found", "edges[0].source"],
    ["an unknown callee", { source: "ws-1", target: "gone" }, "callee workspace not found", "edges[0].target"],
  ])("refuses %s and names the end", (_case, edge, message, field) => {
    const save = vi.fn(() => stored);

    expect(() => saveWorkspaceGraph({ edges: [edge] }, deps({ save }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message, details: { field } }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  // A document is written whole, so one dangling end stops the save: writing the rest would make a
  // stale canvas the stored one.
  it("writes none of the document when a later edge is the dangling one", () => {
    const save = vi.fn(() => stored);
    const edges = [
      { id: "call_a", source: "ws-1", target: "ws-2" },
      { id: "call_b", source: "ws-2", target: "deleted-yesterday" },
    ];

    expect(() => saveWorkspaceGraph({ edges }, deps({ save }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", details: { field: "edges[1].target" } }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  // The store would refuse this too, as a cycle. That answer is true and no help to whoever drew it.
  it("names a self-edge rather than leaving it to come back as a cycle", () => {
    const workspaceExists = vi.fn(() => true);

    expect(() =>
      saveWorkspaceGraph({ edges: [{ source: "ws-1", target: "ws-1" }] }, deps({ workspaceExists })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", message: "a workspace cannot call itself" }));
    expect(workspaceExists).not.toHaveBeenCalled();
  });
});

describe("a malformed document", () => {
  it.each([
    ["edges that are not a list", { edges: { source: "ws-1" } }, "edges"],
    ["an edge that is not an object", { edges: ["ws-1->ws-2"] }, "edges[0]"],
    ["an edge missing its source", { edges: [{ target: "ws-2" }] }, "edges[0].source"],
    ["an edge missing its target", { edges: [{ source: "ws-1" }] }, "edges[0].target"],
    ["a blank source", { edges: [{ source: "   ", target: "ws-2" }] }, "edges[0].source"],
    ["a wrong-typed target", { edges: [{ source: "ws-1", target: 7 }] }, "edges[0].target"],
    ["positions that are not an object", { positions: [] }, "positions"],
  ])("rejects %s and names the field", (_case, input, field) => {
    const save = vi.fn(() => stored);

    expect(() => saveWorkspaceGraph(input, deps({ save }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field } }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  // A canvas saves every edge at once, so the index is the whole value of the field name:
  // "edges[0].source" points into the document, "source" is a guessing game.
  it("names which edge in the document was the bad one", () => {
    const edges = [
      { id: "call_a", source: "ws-1", target: "ws-2" },
      { id: "call_b", source: "ws-2", target: "ws-3" },
      { id: "call_c", source: "ws-3", target: null },
    ];

    expect(() => saveWorkspaceGraph({ edges }, deps())).toThrowError(
      expect.objectContaining({ details: { field: "edges[2].target" } }),
    );
  });
});
