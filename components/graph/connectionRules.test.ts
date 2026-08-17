import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { applyConnection, resolveConnection } from "./connectionRules";
import { DRIVE_EDGE_STYLE } from "./edgeStyles";
import { WORKSPACE_TOP_HANDLE } from "./handles";

const driveIds = new Set(["drive-1", "drive-2"]);
const link = (source: string, target: string) => ({ source, target, sourceHandle: null, targetHandle: null });
const agentEdge = (id: string, source: string, target: string): Edge => ({ id, source, target });

describe("resolveConnection", () => {
  it("rejects a node linked to itself", () => {
    const outcome = resolveConnection(link("ws-1", "ws-1"), { driveIds, edges: [] });
    expect(outcome).toEqual({ kind: "rejected", message: "A node cannot connect to itself." });
  });

  it("rejects a drive linked to another drive", () => {
    const outcome = resolveConnection(link("drive-1", "drive-2"), { driveIds, edges: [] });
    expect(outcome).toEqual({ kind: "rejected", message: "Drives can only connect to workspaces." });
  });

  it("rejects an agent link that closes a loop", () => {
    const edges = [agentEdge("e1", "ws-1", "ws-2"), agentEdge("e2", "ws-2", "ws-3")];
    const outcome = resolveConnection(link("ws-3", "ws-1"), { driveIds, edges });
    expect(outcome.kind).toBe("rejected");
  });

  it("allows a second path to the same node, which is not a loop", () => {
    const edges = [agentEdge("e1", "ws-1", "ws-2"), agentEdge("e2", "ws-2", "ws-3")];
    expect(resolveConnection(link("ws-1", "ws-3"), { driveIds, edges }).kind).toBe("agent-link");
  });

  it("does not read a drive link as part of the agent DAG", () => {
    const edges: Edge[] = [{ id: "d1", source: "drive-1", target: "ws-1", ...DRIVE_EDGE_STYLE }];
    expect(resolveConnection(link("ws-1", "ws-2"), { driveIds, edges }).kind).toBe("agent-link");
  });

  it("normalizes a drive link's workspace handle", () => {
    const outcome = resolveConnection(link("drive-1", "ws-1"), { driveIds, edges: [] });
    expect(outcome.kind === "drive-link" && outcome.edge.targetHandle).toBe(WORKSPACE_TOP_HANDLE);
  });

  it("moves an existing drive link rather than stacking a second one", () => {
    const edges: Edge[] = [
      {
        id: "d1",
        source: "drive-1",
        target: "ws-1",
        sourceHandle: "drive-top",
        targetHandle: WORKSPACE_TOP_HANDLE,
        ...DRIVE_EDGE_STYLE,
      },
    ];
    const outcome = resolveConnection(
      { source: "drive-1", target: "ws-1", sourceHandle: "drive-bottom", targetHandle: WORKSPACE_TOP_HANDLE },
      { driveIds, edges },
    );
    expect(outcome.kind === "drive-link" && outcome.replaces).toBe("d1");
    expect(applyConnection(outcome, edges)).toHaveLength(1);
  });

  it("ignores a redraw of a drive link that already looks that way", () => {
    const edges: Edge[] = [
      {
        id: "d1",
        source: "drive-1",
        target: "ws-1",
        sourceHandle: "drive-top",
        targetHandle: WORKSPACE_TOP_HANDLE,
        ...DRIVE_EDGE_STYLE,
      },
    ];
    const outcome = resolveConnection(
      { source: "drive-1", target: "ws-1", sourceHandle: "drive-top", targetHandle: WORKSPACE_TOP_HANDLE },
      { driveIds, edges },
    );
    expect(outcome.kind).toBe("ignored");
  });
});

describe("applyConnection", () => {
  it("appends a drive link to a workspace it had none with", () => {
    const outcome = resolveConnection(link("drive-1", "ws-1"), { driveIds, edges: [] });
    expect(applyConnection(outcome, [])).toHaveLength(1);
  });

  it("leaves the edges untouched for an outcome that is not a link", () => {
    const edges = [agentEdge("e1", "ws-1", "ws-2")];
    expect(applyConnection({ kind: "ignored" }, edges)).toBe(edges);
  });
});
