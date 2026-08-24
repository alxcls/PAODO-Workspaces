/**
 * The workspace-edge rules, pinned before they move.
 *
 * These edges decide which workspace may delegate to which, so the store is a security boundary as
 * much as a drawing: `isCaller` decides whether a workspace is handed the call tools at all,
 * `getCallees` is the list one agent sees, and `canCall` gates the delegation itself. Today the only
 * writer is the graph canvas, which applies a second copy of these rules in the browser before it
 * saves (components/graph/connectionRules.ts). A future non-browser writer — a CLI, an MCP adapter —
 * reaches the store without passing that copy, so what the store enforces on its own is the real
 * contract and is what this file describes.
 *
 * The last block is the other half of that contract: rules the canvas applies that the store does
 * NOT, asserted as they behave today so the gap is visible rather than assumed closed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AppError } from "@/lib/errors/appError";
import type { GraphEdge, NodePosition } from "./graph";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-graph-test-"));
const GRAPH_FILE = path.join(ROOT, ".workspace-graph.json");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type GraphModule = typeof import("./graph");
interface StoredGraph {
  edges: GraphEdge[];
  positions: Record<string, NodePosition>;
}

const edge = (id: string, source: string, target: string): GraphEdge => ({ id, source, target });
const cell = (col: number, row: number) => ({ col, row });
const readFile = (): StoredGraph => JSON.parse(fs.readFileSync(GRAPH_FILE, "utf-8"));

/** What a saved edge is, minus the id the store replaced: an id a test chose is not one it can then
 *  assert on, because minting them is the store's job and is asserted on its own below. */
const pairs = (edges: GraphEdge[]) => edges.map(({ source, target }) => `${source}->${target}`);

/**
 * The refusal a save raises, asserted by `code` rather than by `instanceof AppError`: every test
 * re-imports the store through a reset module registry, which hands it a second copy of the error
 * class that fails the identity check. The code is the part callers key on anyway — it is what turns
 * this into a 400 rather than a 500 — so checking it is both stable here and closer to the contract.
 */
function refusal(save: () => void): AppError {
  try {
    save();
  } catch (err) {
    return err as AppError;
  }
  return expect.unreachable("the save should have been refused");
}

interface FreshOptions {
  /** Written to disk before the import, for tests that need existing edges without calling saveGraph. */
  seed?: StoredGraph;
  /** Makes every persist throw, to reach the paths that must survive a failing disk. */
  failSaves?: boolean;
}

/**
 * The store captures WORKSPACES_ROOT at import and caches its state on a process global (so every
 * Next.js module instance shares one graph), so a test gets a clean store only by clearing the temp
 * root, the global, and the module registry together.
 */
async function freshGraph({ seed, failSaves }: FreshOptions = {}): Promise<GraphModule> {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  if (seed) fs.writeFileSync(GRAPH_FILE, JSON.stringify(seed));
  process.env.WORKSPACES_ROOT = ROOT;
  delete (global as { __singletons?: unknown }).__singletons;
  vi.resetModules();
  if (failSaves) {
    vi.doMock("../infra/jsonPersist", async () => ({
      ...(await vi.importActual<typeof import("../infra/jsonPersist")>("../infra/jsonPersist")),
      atomicSaveJson: () => {
        throw new Error("disk full");
      },
    }));
  }
  return import("./graph");
}

let graph: GraphModule;

beforeEach(async () => {
  graph = await freshGraph();
});

afterEach(() => {
  vi.doUnmock("../infra/jsonPersist");
});

describe("saveGraph", () => {
  it("keeps a graph that only flows downward", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];
    graph.saveGraph(edges, { a: cell(0, 0) });
    expect(pairs(graph.getGraph().edges)).toEqual(["a->b", "b->c"]);
  });

  it("keeps a diamond, where two paths rejoin without flowing back up", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")];
    graph.saveGraph(edges, {});
    expect(graph.getGraph().edges).toHaveLength(4);
  });

  it("refuses a two-workspace loop", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "a")];
    expect(refusal(() => graph.saveGraph(edges, {})).code).toBe("INVALID_REQUEST");
  });

  it("refuses a loop that closes further down the chain", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];
    expect(refusal(() => graph.saveGraph(edges, {})).message).toMatch(/cycle/i);
  });

  it("refuses a workspace that calls itself", () => {
    expect(refusal(() => graph.saveGraph([edge("e1", "a", "a")], {})).code).toBe("INVALID_REQUEST");
  });

  it("leaves the stored graph untouched when it refuses", () => {
    const kept = [edge("e1", "a", "b")];
    graph.saveGraph(kept, { a: cell(1, 1) });
    refusal(() => graph.saveGraph([...kept, edge("e2", "b", "a")], {}));
    expect(pairs(graph.getGraph().edges)).toEqual(["a->b"]);
    expect(pairs(readFile().edges)).toEqual(["a->b"]);
  });

  it("gives every edge an id of its own, whatever the caller called it", () => {
    const stored = graph.saveGraph([edge("dup", "a", "b"), edge("dup", "b", "c")], {});

    expect(stored.edges.map((saved) => saved.id)).toEqual([
      expect.stringMatching(/^call_/),
      expect.stringMatching(/^call_/),
    ]);
    expect(new Set(stored.edges.map((saved) => saved.id)).size).toBe(2);
  });

  it("answers in the order it was sent, which is what lets a caller adopt the ids", () => {
    const stored = graph.saveGraph([edge("e1", "a", "b"), edge("e2", "b", "c")], {});

    expect(pairs(stored.edges)).toEqual(["a->b", "b->c"]);
    expect(stored.edges).toEqual(graph.getGraph().edges);
  });

  // Otherwise every save renames every edge, and an id no caller can hold for two saves is not one.
  it("leaves an id it minted alone when the same edge is saved again", () => {
    const first = graph.saveGraph([edge("e1", "a", "b")], {});
    const again = graph.saveGraph(first.edges, {});

    expect(again.edges).toEqual(first.edges);
  });

  // The prefix is public, so wearing it is not proof this store issued it. An edge id is what a
  // removal addresses, against the graph that decides which workspace may delegate to which.
  it("replaces a call_ id it never issued, rather than trusting the prefix", () => {
    const stored = graph.saveGraph([edge("call_invented-by-the-caller", "a", "b")], {});
    expect(stored.edges[0].id).not.toBe("call_invented-by-the-caller");
    expect(stored.edges[0].id).toMatch(/^call_/);
  });

  it("refuses to let one of its own ids be reused for a second edge in the same save", () => {
    const first = graph.saveGraph([edge("e1", "a", "b")], {});
    const reused = first.edges[0].id;
    const stored = graph.saveGraph([{ ...first.edges[0] }, edge(reused, "b", "c")], {});

    expect(pairs(stored.edges)).toEqual(["a->b", "b->c"]);
    expect(stored.edges[0].id).toBe(reused);
    expect(stored.edges[1].id).not.toBe(reused);
  });

  it("persists, so a later reader sees edges it did not write", async () => {
    graph.saveGraph([edge("e1", "a", "b")], { a: cell(2, 3) });
    const reloaded = await freshGraph({ seed: readFile() });
    expect(reloaded.canCall("a", "b")).toBe(true);
    expect(reloaded.getGraph().positions.a).toEqual(cell(2, 3));
  });
});

describe("call gating", () => {
  beforeEach(() => {
    graph.saveGraph([edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d")], {});
  });

  it("permits a call only along the edge's direction", () => {
    expect(graph.canCall("a", "b")).toBe(true);
    expect(graph.canCall("b", "a")).toBe(false);
  });

  it("refuses a call to a workspace two steps down, which has no edge of its own", () => {
    expect(graph.canCall("a", "d")).toBe(false);
  });

  it("lists only the workspaces directly below the caller", () => {
    expect(graph.getCallees("a").sort()).toEqual(["b", "c"]);
    expect(graph.getCallees("d")).toEqual([]);
  });

  it("treats a workspace as a caller only where it is the source of an edge", () => {
    expect(graph.isCaller("a")).toBe(true);
    expect(graph.isCaller("b")).toBe(true);
    expect(graph.isCaller("d")).toBe(false);
  });

  it("answers for a workspace that is not on the graph at all", () => {
    expect(graph.isCaller("absent")).toBe(false);
    expect(graph.canCall("absent", "b")).toBe(false);
    expect(graph.getCallees("absent")).toEqual([]);
  });
});

describe("removeWorkspaceFromGraph", () => {
  it("drops the deleted workspace's edges in both directions and leaves its neighbours linked", () => {
    graph.saveGraph([edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "a", "c")], {});
    graph.removeWorkspaceFromGraph("b");
    expect(pairs(graph.getGraph().edges)).toEqual(["a->c"]);
    expect(graph.canCall("a", "c")).toBe(true);
  });

  it("stops the deleted workspace appearing in any listing", () => {
    graph.saveGraph([edge("e1", "a", "b")], {});
    graph.removeWorkspaceFromGraph("b");
    expect(graph.getCallees("a")).toEqual([]);
    expect(graph.isCaller("a")).toBe(false);
  });

  it("drops the canvas position too, so a reused id does not inherit a cell", () => {
    graph.saveGraph([], { a: cell(0, 0), b: cell(1, 0) });
    graph.removeWorkspaceFromGraph("b");
    expect(graph.getGraph().positions).toEqual({ a: cell(0, 0) });
  });

  it("persists the removal", () => {
    graph.saveGraph([edge("e1", "a", "b")], {});
    graph.removeWorkspaceFromGraph("a");
    expect(readFile().edges).toEqual([]);
  });

  it("writes nothing for a workspace the graph never held", () => {
    graph.saveGraph([edge("e1", "a", "b")], {});
    fs.rmSync(GRAPH_FILE);
    graph.removeWorkspaceFromGraph("absent");
    expect(fs.existsSync(GRAPH_FILE)).toBe(false);
  });

  it("still forgets the workspace when the save fails, because it runs mid-delete-cascade", async () => {
    const failing = await freshGraph({
      seed: { edges: [edge("e1", "a", "b")], positions: { b: cell(0, 0) } },
      failSaves: true,
    });
    expect(() => failing.removeWorkspaceFromGraph("b")).not.toThrow();
    expect(failing.getGraph().edges).toEqual([]);
    expect(failing.canCall("a", "b")).toBe(false);
  });
});

/**
 * The per-edge writes, which exist so a writer with no canvas can add or remove one edge. What
 * separates them from saveGraph is what they do NOT touch: `positions` is carried through from what is
 * stored, never from the caller, so a CLI that has no layout to send cannot cost the editor one.
 */
describe("addCallEdge and removeCallEdge", () => {
  it("adds one edge and leaves the stored positions exactly as they were", () => {
    graph.saveGraph([edge("e1", "a", "b")], { a: cell(1, 2), b: cell(3, 4) });
    const added = graph.addCallEdge("b", "c");

    expect(added.id).toMatch(/^call_/);
    expect(pairs(graph.getGraph().edges)).toEqual(["a->b", "b->c"]);
    expect(readFile().positions).toEqual({ a: cell(1, 2), b: cell(3, 4) });
  });

  it("answers with the edge already there rather than a second one beside it", () => {
    const first = graph.addCallEdge("a", "b");
    expect(graph.addCallEdge("a", "b")).toEqual(first);
    expect(graph.getGraph().edges).toHaveLength(1);
  });

  it("refuses an edge that would close a loop, without writing anything", () => {
    graph.saveGraph([edge("e1", "a", "b"), edge("e2", "b", "c")], { a: cell(0, 0) });
    expect(refusal(() => graph.addCallEdge("c", "a")).code).toBe("INVALID_REQUEST");
    expect(pairs(graph.getGraph().edges)).toEqual(["a->b", "b->c"]);
    expect(pairs(readFile().edges)).toEqual(["a->b", "b->c"]);
  });

  it("removes the one edge it is given and keeps the rest", () => {
    graph.saveGraph([], { a: cell(5, 5) });
    const removable = graph.addCallEdge("a", "b");
    graph.addCallEdge("a", "c");

    expect(graph.removeCallEdge(removable.id)).toBe(true);
    expect(pairs(graph.getGraph().edges)).toEqual(["a->c"]);
    expect(readFile().positions).toEqual({ a: cell(5, 5) });
  });

  it("reports an id the graph does not hold as already gone, and writes nothing", () => {
    graph.saveGraph([edge("e1", "a", "b")], {});
    fs.rmSync(GRAPH_FILE);

    expect(graph.removeCallEdge("call_never-issued")).toBe(false);
    expect(fs.existsSync(GRAPH_FILE)).toBe(false);
    expect(pairs(graph.getGraph().edges)).toEqual(["a->b"]);
  });

  it("takes an edge out of call gating, not just the listing", () => {
    const added = graph.addCallEdge("a", "b");
    expect(graph.canCall("a", "b")).toBe(true);
    graph.removeCallEdge(added.id);
    expect(graph.canCall("a", "b")).toBe(false);
    expect(graph.isCaller("a")).toBe(false);
  });
});

/**
 * What the canvas refuses and the store accepts. Each of these is a rule that exists only in
 * components/graph/connectionRules.ts, or in React Flow's own edge handling, and therefore does not
 * apply to any writer that is not the canvas. Asserted as the store behaves TODAY: a change here is
 * the point at which one of these moved down into the store, not a regression.
 */
describe("rules the store does not enforce on its own", () => {
  it("accepts a second edge on a pair the canvas would have deduplicated", () => {
    graph.saveGraph([edge("e1", "a", "b"), edge("e2", "a", "b")], {});
    expect(graph.getGraph().edges).toHaveLength(2);
    expect(graph.getCallees("a")).toEqual(["b", "b"]);
  });

  it("accepts an edge naming a workspace that does not exist, having no registry to ask", () => {
    graph.saveGraph([edge("e1", "real", "deleted-yesterday")], {});
    expect(graph.canCall("real", "deleted-yesterday")).toBe(true);
  });

  it("accepts a position for a node that no edge mentions", () => {
    graph.saveGraph([], { "not-a-workspace": cell(9, 9) });
    expect(graph.getGraph().positions["not-a-workspace"]).toEqual(cell(9, 9));
  });
});
