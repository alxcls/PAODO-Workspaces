import { describe, expect, it, vi } from "vitest";
import { connectDriveToWorkspace, disconnectDriveFromWorkspace, type DriveConnectionDeps } from "./connect";
import type { DriveConnection } from "@/lib/drives/store";

const connection: DriveConnection = {
  id: "conn-1",
  driveId: "drive-1",
  workspaceId: "ws-1",
};

function deps(overrides: Partial<DriveConnectionDeps> = {}): DriveConnectionDeps {
  return {
    driveExists: (driveId) => driveId === "drive-1",
    workspaceExists: (workspaceId) => workspaceId === "ws-1",
    connect: vi.fn(() => connection),
    disconnect: vi.fn(() => true),
    ...overrides,
  };
}

describe("connecting a drive to a workspace", () => {
  it("links the pair and passes the handles through", () => {
    const connect = vi.fn(() => connection);

    const result = connectDriveToWorkspace(
      { driveId: "drive-1", workspaceId: "ws-1", sourceHandle: "right", targetHandle: "left" },
      deps({ connect }),
    );

    expect(result).toBe(connection);
    expect(connect).toHaveBeenCalledWith("drive-1", "ws-1", { sourceHandle: "right", targetHandle: "left" });
  });

  it("treats an absent handle as no handle recorded", () => {
    const connect = vi.fn(() => connection);

    connectDriveToWorkspace({ driveId: "drive-1", workspaceId: "ws-1", targetHandle: null }, deps({ connect }));

    expect(connect).toHaveBeenCalledWith("drive-1", "ws-1", { sourceHandle: undefined, targetHandle: undefined });
  });

  it("refuses an unknown drive without writing a dangling connection", () => {
    const connect = vi.fn(() => connection);

    expect(() => connectDriveToWorkspace({ driveId: "gone", workspaceId: "ws-1" }, deps({ connect }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message: "drive not found" }),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses an unknown workspace without writing a dangling connection", () => {
    const connect = vi.fn(() => connection);

    expect(() => connectDriveToWorkspace({ driveId: "drive-1", workspaceId: "gone" }, deps({ connect }))).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND", message: "workspace not found" }),
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing driveId", { workspaceId: "ws-1" }, "driveId"],
    ["a missing workspaceId", { driveId: "drive-1" }, "workspaceId"],
    ["a blank driveId", { driveId: "   ", workspaceId: "ws-1" }, "driveId"],
    ["a wrong-typed driveId", { driveId: 7, workspaceId: "ws-1" }, "driveId"],
  ])("rejects %s and names the field", (_case, input, field) => {
    expect(() => connectDriveToWorkspace(input, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field } }),
    );
  });

  it("rejects a wrong-typed handle before checking either entity exists", () => {
    const driveExists = vi.fn(() => true);

    expect(() =>
      connectDriveToWorkspace({ driveId: "drive-1", workspaceId: "ws-1", sourceHandle: 3 }, deps({ driveExists })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", details: { field: "sourceHandle" } }));
    expect(driveExists).not.toHaveBeenCalled();
  });
});

describe("disconnecting a drive", () => {
  it("reports the removal", () => {
    expect(disconnectDriveFromWorkspace({ connectionId: "conn-1" }, deps())).toEqual({ deleted: true });
  });

  it("reports an unknown connection as already gone rather than raising", () => {
    expect(disconnectDriveFromWorkspace({ connectionId: "conn-9" }, deps({ disconnect: () => false }))).toEqual({
      deleted: false,
    });
  });

  it("requires a connectionId", () => {
    expect(() => disconnectDriveFromWorkspace({}, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", details: { field: "connectionId" } }),
    );
  });
});
