import { describe, expect, it } from "vitest";
import { connectionListing, type ConnectionListDeps } from "./list";
import type { GraphEdge } from "@/lib/agent/graph";
import type { DriveConnection } from "@/lib/drives/store";

function link(id: string, driveId: string, workspaceId: string): DriveConnection {
  return { id, driveId, workspaceId };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target };
}

function deps(overrides: Partial<ConnectionListDeps> = {}): ConnectionListDeps {
  return {
    workspaces: () => [
      { id: "ws-1", name: "Sales" },
      { id: "ws-2", name: "Billing" },
    ],
    drives: () => [
      { id: "dr-1", name: "Assets" },
      { id: "dr-2", name: "Archive" },
    ],
    links: () => [],
    edges: () => [],
    ...overrides,
  };
}

describe("listing every connection", () => {
  it("answers both kinds as empty lists when nothing is connected", () => {
    expect(connectionListing(undefined, deps())).toEqual({ driveLinks: [], agentCalls: [] });
  });

  it("names both ends of each kind under the role each plays", () => {
    const d = deps({
      links: () => [link("link_1", "dr-1", "ws-1")],
      edges: () => [edge("call_1", "ws-1", "ws-2")],
    });

    expect(connectionListing(undefined, d)).toEqual({
      driveLinks: [{ id: "link_1", drive: { id: "dr-1", name: "Assets" }, workspace: { id: "ws-1", name: "Sales" } }],
      agentCalls: [{ id: "call_1", caller: { id: "ws-1", name: "Sales" }, callee: { id: "ws-2", name: "Billing" } }],
    });
  });

  it("orders rows by the names they join, not by the order stored", () => {
    const d = deps({
      links: () => [link("link_1", "dr-1", "ws-1"), link("link_2", "dr-2", "ws-1"), link("link_3", "dr-1", "ws-2")],
    });

    const listing = connectionListing(undefined, d) as { driveLinks: Array<{ id: string }> };

    expect(listing.driveLinks.map((row) => row.id)).toEqual(["link_2", "link_3", "link_1"]);
  });

  it("keeps a row whose end no longer exists, with a null name", () => {
    const d = deps({
      links: () => [link("link_1", "dr-gone", "ws-1")],
      edges: () => [edge("call_1", "ws-1", "ws-gone")],
    });

    expect(connectionListing(undefined, d)).toEqual({
      driveLinks: [{ id: "link_1", drive: { id: "dr-gone", name: null }, workspace: { id: "ws-1", name: "Sales" } }],
      agentCalls: [{ id: "call_1", caller: { id: "ws-1", name: "Sales" }, callee: { id: "ws-gone", name: null } }],
    });
  });
});

describe("listing one workspace's connections", () => {
  it("groups its drives, callers and callees, each row holding only the far end", () => {
    const d = deps({
      links: () => [link("link_1", "dr-1", "ws-1"), link("link_2", "dr-2", "ws-2")],
      edges: () => [edge("call_1", "ws-1", "ws-2"), edge("call_2", "ws-2", "ws-1")],
    });

    expect(connectionListing("ws-1", d)).toEqual({
      workspace: { id: "ws-1", name: "Sales" },
      drives: [{ id: "link_1", drive: { id: "dr-1", name: "Assets" } }],
      callers: [{ id: "call_2", caller: { id: "ws-2", name: "Billing" } }],
      callees: [{ id: "call_1", callee: { id: "ws-2", name: "Billing" } }],
    });
  });

  it("answers every group empty for a workspace nothing is connected to", () => {
    expect(connectionListing("ws-1", deps())).toEqual({
      workspace: { id: "ws-1", name: "Sales" },
      drives: [],
      callers: [],
      callees: [],
    });
  });
});

describe("listing one drive's connections", () => {
  it("lists the workspaces linked to it and nothing about agent calls", () => {
    const d = deps({
      links: () => [link("link_1", "dr-1", "ws-1"), link("link_2", "dr-2", "ws-2")],
      edges: () => [edge("call_1", "ws-1", "ws-2")],
    });

    expect(connectionListing("dr-1", d)).toEqual({
      drive: { id: "dr-1", name: "Assets" },
      workspaces: [{ id: "link_1", workspace: { id: "ws-1", name: "Sales" } }],
    });
  });
});

describe("an id that names nothing", () => {
  it("is refused as not found rather than answered with an empty listing", () => {
    expect(() => connectionListing("nope", deps())).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message: "no workspace or drive has the id nope" }),
    );
  });

  it("is refused as invalid when it is empty", () => {
    expect(() => connectionListing("", deps())).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
