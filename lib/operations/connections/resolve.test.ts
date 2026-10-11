import { describe, expect, it, vi } from "vitest";
import { connect, disconnect, type ConnectionDeps } from "./resolve";

const LINK_ID = "link_9b2f0f4e-0000-4000-8000-000000000000";
const CALL_ID = "call_9b2f0f4e-0000-4000-8000-000000000000";

function deps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    workspaceName: (id) => ({ "ws-1": "Sales", "ws-2": "Billing" })[id],
    driveName: (id) => ({ "dr-1": "Assets", "dr-2": "Archive" })[id],
    linkDrive: vi.fn(() => ({ id: LINK_ID, driveId: "dr-1", workspaceId: "ws-1" }) as never),
    unlinkDrive: vi.fn(() => ({ deleted: true })),
    connectCall: vi.fn(() => ({ id: CALL_ID, source: "ws-1", target: "ws-2" })),
    disconnectCall: vi.fn(() => ({ deleted: true })),
    ...overrides,
  };
}

describe("connecting two ids", () => {
  it("makes an agent call from two workspaces, the first calling the second", () => {
    const d = deps();

    expect(connect({ from: "ws-1", to: "ws-2" }, d)).toEqual({
      kind: "call",
      id: CALL_ID,
      caller: { id: "ws-1", name: "Sales" },
      callee: { id: "ws-2", name: "Billing" },
    });
    expect(d.connectCall).toHaveBeenCalledWith({ source: "ws-1", target: "ws-2" });
    expect(d.linkDrive).not.toHaveBeenCalled();
  });

  it.each([
    ["drive first", { from: "dr-1", to: "ws-1" }],
    ["workspace first", { from: "ws-1", to: "dr-1" }],
  ])("makes the same drive link with the %s", (_case, input) => {
    const d = deps();

    expect(connect(input, d)).toEqual({
      kind: "link",
      id: LINK_ID,
      drive: { id: "dr-1", name: "Assets" },
      workspace: { id: "ws-1", name: "Sales" },
    });
    expect(d.linkDrive).toHaveBeenCalledWith({ driveId: "dr-1", workspaceId: "ws-1" });
    expect(d.connectCall).not.toHaveBeenCalled();
  });

  it("refuses two drives without writing", () => {
    const d = deps();

    expect(() => connect({ from: "dr-1", to: "dr-2" }, d)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining("two drives") }),
    );
    expect(d.linkDrive).not.toHaveBeenCalled();
  });

  it("refuses the same id twice before either lookup", () => {
    const workspaceName = vi.fn(() => "Sales");

    expect(() => connect({ from: "ws-1", to: "ws-1" }, deps({ workspaceName }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining("both ids are the same") }),
    );
    expect(workspaceName).not.toHaveBeenCalled();
  });

  it("names an id neither registry holds, and which slot it was in", () => {
    expect(() => connect({ from: "ws-1", to: "gone" }, deps())).toThrowError(
      expect.objectContaining({
        code: "NOT_FOUND",
        message: "no workspace or drive has the id gone",
        details: { field: "to" },
      }),
    );
  });

  it("rejects a missing end and names the field", () => {
    expect(() => connect({ from: "ws-1" }, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: expect.objectContaining({ field: "to" }) }),
    );
  });
});

describe("removing a connection by id", () => {
  it("sends a link id to the drive graph and a call id to the call graph", () => {
    const d = deps();

    expect(disconnect(LINK_ID, d)).toEqual({ deleted: true });
    expect(d.unlinkDrive).toHaveBeenCalledWith({ connectionId: LINK_ID });
    expect(disconnect(CALL_ID, d)).toEqual({ deleted: true });
    expect(d.disconnectCall).toHaveBeenCalledWith({ connectionId: CALL_ID });
  });

  // `deleted: false` is true of every string, so a workspace id sent here must not get that answer.
  it("refuses an id that belongs to neither graph", () => {
    const d = deps();

    expect(() => disconnect("ws-1", d)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining("is not a connection id") }),
    );
    expect(d.unlinkDrive).not.toHaveBeenCalled();
    expect(d.disconnectCall).not.toHaveBeenCalled();
  });
});
