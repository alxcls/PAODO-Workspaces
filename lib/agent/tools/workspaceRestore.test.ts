// WorkspaceRestoreTool is signal-only: _call validates the target shape and returns an ack; the
// runner performs the actual restore (covered in runner.test.ts). These tests pin the explicit
// restore ack and the early sha-format guard.

import { describe, it, expect } from "vitest";
import { WorkspaceRestoreTool } from "./workspaceRestore";

const tool = () => new WorkspaceRestoreTool();

describe("WorkspaceRestoreTool", () => {
  it("requires a sha", async () => {
    await expect(tool().invoke({})).rejects.toThrow("Received tool input did not match expected schema");
  });

  it("acks reverting to a specific snapshot when a sha is given", async () => {
    const out = await tool().invoke({ sha: "deadbee" });
    expect(out).toContain("deadbee");
    expect(out).toContain("Files only");
  });

  it("rejects a non-hex sha before signalling a restore", async () => {
    const out = await tool().invoke({ sha: "not a sha!" });
    expect(out).toContain("invalid sha");
  });
});
