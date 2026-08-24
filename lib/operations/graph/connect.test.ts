import { describe, expect, it, vi } from "vitest";
import { connectWorkspaces, disconnectWorkspaces, type WorkspaceCallDeps } from "./connect";
import type { GraphEdge } from "@/lib/agent/graph";

const CALL_ID = "call_9b2f0f4e-0000-4000-8000-000000000000";

const edge: GraphEdge = { id: CALL_ID, source: "ws-1", target: "ws-2" };

function deps(overrides: Partial<WorkspaceCallDeps> = {}): WorkspaceCallDeps {
  return {
    workspaceExists: (workspaceId) => ["ws-1", "ws-2"].includes(workspaceId),
    connect: vi.fn(() => edge),
    disconnect: vi.fn(() => true),
    ...overrides,
  };
}

describe("connecting one workspace to another", () => {
  it("passes the pair through in the direction it was given", () => {
    const connect = vi.fn(() => edge);

    expect(connectWorkspaces({ source: "ws-1", target: "ws-2" }, deps({ connect }))).toBe(edge);
    expect(connect).toHaveBeenCalledWith("ws-1", "ws-2");
  });

  it("refuses an unknown caller without writing a dangling edge", () => {
    const connect = vi.fn(() => edge);

    expect(() => connectWorkspaces({ source: "gone", target: "ws-2" }, deps({ connect }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message: "caller workspace not found" }),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses an unknown callee without writing a dangling edge", () => {
    const connect = vi.fn(() => edge);

    expect(() => connectWorkspaces({ source: "ws-1", target: "gone" }, deps({ connect }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message: "callee workspace not found" }),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  // The store would refuse a self-edge too, as a cycle. That answer is true and no help to whoever
  // pasted one id twice, so this names what actually happened before either lookup runs.
  it("names a self-edge rather than reporting it as a cycle", () => {
    const workspaceExists = vi.fn(() => true);

    expect(() => connectWorkspaces({ source: "ws-1", target: "ws-1" }, deps({ workspaceExists }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: "a workspace cannot call itself" }),
    );
    expect(workspaceExists).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing source", { target: "ws-2" }, "source"],
    ["a missing target", { source: "ws-1" }, "target"],
    ["a blank source", { source: "   ", target: "ws-2" }, "source"],
    ["a wrong-typed target", { source: "ws-1", target: 7 }, "target"],
  ])("rejects %s and names the field", (_case, input, field) => {
    expect(() => connectWorkspaces(input, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field } }),
    );
  });
});

describe("disconnecting two workspaces", () => {
  it("reports the removal", () => {
    expect(disconnectWorkspaces({ connectionId: CALL_ID }, deps())).toEqual({ deleted: true });
  });

  it("reports an unknown edge as already gone rather than raising", () => {
    expect(disconnectWorkspaces({ connectionId: CALL_ID }, deps({ disconnect: () => false }))).toEqual({
      deleted: false,
    });
  });

  it("requires a connectionId", () => {
    expect(() => disconnectWorkspaces({}, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field: "connectionId" } }),
    );
  });

  // `deleted: false` is true of every string ever sent, so it cannot be the answer to an id that
  // belongs to the other graph or to no graph — the caller would read "already gone" and stop looking.
  it.each([
    ["a drive link id", "link_3f7a1c62-0000-4000-8000-000000000000"],
    ["a workspace id", "b6b8b4f1-0000-4000-8000-000000000000"],
  ])("refuses %s instead of reporting it already gone", (_label, connectionId) => {
    const disconnect = vi.fn(() => false);

    expect(() => disconnectWorkspaces({ connectionId }, deps({ disconnect }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field: "connectionId" } }),
    );
    expect(disconnect).not.toHaveBeenCalled();
  });
});
