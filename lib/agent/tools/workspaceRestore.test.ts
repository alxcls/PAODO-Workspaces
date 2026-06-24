// WorkspaceRestoreTool is signal-only: _call validates the target shape and returns an ack; the
// runner performs the actual restore (covered in runner.test.ts). These tests pin the two acks
// (no sha → undo-this-run, sha → that snapshot) and the early sha-format guard.

import { describe, it, expect } from "vitest";
import { WorkspaceRestoreTool } from "./workspaceRestore";

const tool = () => new WorkspaceRestoreTool();

describe("WorkspaceRestoreTool", () => {
  it("acks reverting this run's changes when no sha is given", async () => {
    const out = await tool().invoke({});
    expect(out).toContain("this run's starting state");
    expect(out).toContain("external side effects");
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
