import { describe, expect, it } from "vitest";
import { driveConnectionCounts, workspaceConnectionCounts, type ConnectionCountDeps } from "./counts";
import type { GraphEdge } from "@/lib/agent/graph";
import type { DriveConnection } from "@/lib/drives/store";

const LIVE = new Set(["ws-1", "ws-2", "ws-3"]);

function link(id: string, driveId: string, workspaceId: string): DriveConnection {
  return { id, driveId, workspaceId };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target };
}

function deps(overrides: Partial<ConnectionCountDeps> = {}): ConnectionCountDeps {
  return {
    drivesForWorkspace: () => [],
    connections: () => [],
    edges: () => [],
    workspaceExists: (workspaceId) => LIVE.has(workspaceId),
    ...overrides,
  };
}

describe("a workspace's connection counts", () => {
  it("reports zero for a workspace nothing is connected to", () => {
    expect(workspaceConnectionCounts("ws-1", deps())).toEqual({ drives: 0, callers: 0, callees: 0 });
  });

  it("counts the drives the store says this workspace can address", () => {
    const counts = workspaceConnectionCounts(
      "ws-1",
      deps({ drivesForWorkspace: (id) => (id === "ws-1" ? [{}, {}] : []) }),
    );

    expect(counts.drives).toBe(2);
  });

  it("separates who may call this workspace from who it may call", () => {
    const edges = [edge("e-1", "ws-2", "ws-1"), edge("e-2", "ws-1", "ws-3")];

    expect(workspaceConnectionCounts("ws-1", deps({ edges: () => edges }))).toEqual({
      drives: 0,
      callers: 1,
      callees: 1,
    });
  });

  // Direction is the whole meaning of an agent edge, and a count that ignored it would report the
  // same number to a workspace that may delegate and one that may only be delegated to.
  it("does not credit a callee with its caller's reach", () => {
    const edges = [edge("e-1", "ws-1", "ws-2"), edge("e-2", "ws-1", "ws-3")];

    expect(workspaceConnectionCounts("ws-2", deps({ edges: () => edges }))).toEqual({
      drives: 0,
      callers: 1,
      callees: 0,
    });
  });

  it("counts a pair joined twice once, because it is one workspace either way", () => {
    const edges = [edge("e-1", "ws-1", "ws-2"), edge("e-2", "ws-1", "ws-2")];

    expect(workspaceConnectionCounts("ws-1", deps({ edges: () => edges })).callees).toBe(1);
  });

  it("does not count an end that no longer exists, which nothing can reach", () => {
    const edges = [edge("e-1", "ws-1", "ws-deleted"), edge("e-2", "ws-1", "ws-2")];

    expect(workspaceConnectionCounts("ws-1", deps({ edges: () => edges })).callees).toBe(1);
  });
});

describe("a drive's connection counts", () => {
  it("counts the workspaces connected to it", () => {
    const connections = [link("c-1", "dr-1", "ws-1"), link("c-2", "dr-1", "ws-2"), link("c-3", "dr-2", "ws-3")];

    expect(driveConnectionCounts("dr-1", deps({ connections: () => connections }))).toEqual({ workspaces: 2 });
  });

  it("counts a workspace linked twice once", () => {
    const connections = [link("c-1", "dr-1", "ws-1"), link("c-2", "dr-1", "ws-1")];

    expect(driveConnectionCounts("dr-1", deps({ connections: () => connections })).workspaces).toBe(1);
  });

  // The link survives its workspace when the delete-time cleanup fails to persist. It is real, and the
  // connection listing is where it has to be visible — but it is not reach this drive still has.
  it("does not count a link left behind by a deleted workspace", () => {
    const connections = [link("c-1", "dr-1", "ws-deleted")];

    expect(driveConnectionCounts("dr-1", deps({ connections: () => connections })).workspaces).toBe(0);
  });
});
