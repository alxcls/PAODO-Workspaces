// This route was the browser's alone until the CLI was granted its POST and DELETE, so its public
// boundary is pinned here: the statuses, and that a refusal from the operation reaches the caller as
// its own code rather than as a 500 that says nothing about which end was wrong.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/appError";

const h = vi.hoisted(() => ({
  connectDriveToWorkspace: vi.fn(),
  disconnectDriveFromWorkspace: vi.fn(),
}));

vi.mock("@/lib/operations/drives/connect", () => ({
  connectDriveToWorkspace: h.connectDriveToWorkspace,
  disconnectDriveFromWorkspace: h.disconnectDriveFromWorkspace,
}));

import { DELETE, POST } from "./route";

const LINK = { id: "link_3f7a1c62-0000-4000-8000-000000000000", driveId: "drive-1", workspaceId: "ws-1" };

const send = (method: string, body: unknown) =>
  new Request("http://x/api/drive-connections", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  h.connectDriveToWorkspace.mockReset().mockReturnValue(LINK);
  h.disconnectDriveFromWorkspace.mockReset().mockReturnValue({ deleted: true });
});

describe("POST /api/drive-connections", () => {
  it("answers 201 with the link, under the id the store minted", async () => {
    const response = await POST(send("POST", { driveId: "drive-1", workspaceId: "ws-1" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(LINK);
  });

  it("relays the operation's own refusal rather than reporting a server fault", async () => {
    h.connectDriveToWorkspace.mockImplementation(() => {
      throw new AppError("NOT_FOUND", "drive not found", { field: "driveId" });
    });

    const response = await POST(send("POST", { driveId: "gone", workspaceId: "ws-1" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND", error: "drive not found" });
  });

  it("reports an unexpected failure as a 500 that says nothing was persisted", async () => {
    h.connectDriveToWorkspace.mockImplementation(() => {
      throw new Error("disk full");
    });

    const response = await POST(send("POST", { driveId: "drive-1", workspaceId: "ws-1" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
  });
});

describe("DELETE /api/drive-connections", () => {
  it("answers 200 with what happened", async () => {
    const response = await DELETE(send("DELETE", { connectionId: LINK.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("passes an id already gone back as deleted:false, not as a failure", async () => {
    h.disconnectDriveFromWorkspace.mockReturnValue({ deleted: false });

    const response = await DELETE(send("DELETE", { connectionId: LINK.id }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: false });
  });

  it("relays a wrong-graph id as the 400 the operation raised", async () => {
    h.disconnectDriveFromWorkspace.mockImplementation(() => {
      throw new AppError("INVALID_REQUEST", "connectionId must be a drive link id, which starts with link_", {
        field: "connectionId",
      });
    });

    const response = await DELETE(send("DELETE", { connectionId: "call_9b2f0f4e-0000-4000-8000-000000000000" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});
