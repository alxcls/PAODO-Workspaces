// The edit-existing-file branch of file_edit writes via its own inline `tee` call, bypassing
// writeContainerFile (which containerWrite.test.ts already covers) — so its disk-space guard needs
// its own pin: a full disk must be refused before the `tee` that would actually write the edit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import type { ExecRunner } from "../interfaces";

const checkFreeSpace = vi.hoisted(() => vi.fn());
vi.mock("../../workspace/diskSpace", () => ({ checkFreeSpace }));

import { FileEditTool } from "./fileEdit";

// A real, existing directory — FileEditTool also realpath-checks against it (see
// lib/workspace/pathContainment.ts via resolveWorkspacePath).
const WORKSPACE_DIR = os.tmpdir();

function makeRunner(fileContent: string) {
  const exec = vi.fn(async (cmd: string[]) => {
    if (cmd[0] === "cat") return { code: 0, stdout: fileContent, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  return { runner: { exec } as ExecRunner, exec };
}

beforeEach(() => {
  checkFreeSpace.mockReset();
  checkFreeSpace.mockResolvedValue({ ok: true, freeBytes: Infinity });
});

describe("FileEditTool edit-existing-file branch — disk-space guard", () => {
  it("refuses the edit and never writes when the workspace is out of disk space", async () => {
    checkFreeSpace.mockResolvedValue({ ok: false, freeBytes: 0 });
    const { runner, exec } = makeRunner("hello world");
    const tool = new FileEditTool(runner, WORKSPACE_DIR);

    const result = await tool.invoke({ file_path: "notes.md", old_string: "world", new_string: "there" });

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("not enough free disk space");
    expect(exec).not.toHaveBeenCalledWith(["tee", expect.anything()], expect.anything());
  });

  it("applies the edit when there's room", async () => {
    const { runner } = makeRunner("hello world");
    const tool = new FileEditTool(runner, WORKSPACE_DIR);

    const result = await tool.invoke({ file_path: "notes.md", old_string: "world", new_string: "there" });

    expect(result).toBe("Updated notes.md");
  });
});
