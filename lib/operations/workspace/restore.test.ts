import { describe, expect, it, vi } from "vitest";
import { restoreWorkspace } from "./restore";

const workspace = { id: "ws-1", dir: "/private/alpha" };

describe("workspace restore", () => {
  it("resets the work-tree to the snapshot and echoes it", async () => {
    const restore = vi.fn(async () => true);

    await expect(restoreWorkspace(workspace, { sha: "a1b2c3d" }, { restore })).resolves.toEqual({
      restored: true,
      sha: "a1b2c3d",
    });
    expect(restore).toHaveBeenCalledWith("ws-1", "/private/alpha", "a1b2c3d");
  });

  it("accepts a full-length object name", async () => {
    const sha = "0".repeat(40);

    await expect(restoreWorkspace(workspace, { sha }, { restore: async () => true })).resolves.toMatchObject({ sha });
  });

  it("reports a ref that is not a snapshot of this workspace", async () => {
    await expect(restoreWorkspace(workspace, { sha: "a1b2c3d" }, { restore: async () => false })).rejects.toMatchObject(
      { code: "WORKSPACE_UPDATE_INVALID", message: "unknown sha", details: { field: "sha" } },
    );
  });

  it.each([
    ["a missing sha", undefined],
    ["an empty sha", ""],
    ["a too-short sha", "a1b"],
    ["a non-hex sha", "HEAD~1"],
    ["an over-long sha", "0".repeat(41)],
    ["a wrong-typed sha", 12345],
  ])("refuses %s before touching the work-tree", async (_case, sha) => {
    const restore = vi.fn(async () => true);

    await expect(restoreWorkspace(workspace, { sha }, { restore })).rejects.toMatchObject({
      code: "WORKSPACE_UPDATE_INVALID",
      message: "invalid sha",
    });
    expect(restore).not.toHaveBeenCalled();
  });
});
