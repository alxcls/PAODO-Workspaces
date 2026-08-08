// writeContainerFile is the one chokepoint both file_write and file_edit's create branch write
// through — this pins that a full disk is refused BEFORE any container exec runs (no mkdir, no
// tee), the same "don't even try" stance the HTTP upload route takes via checkFreeSpace.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecRunner } from "../interfaces";

const requireFreeSpace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/storage/diskSpace", () => ({ requireFreeSpace }));

import { writeContainerFile } from "./containerWrite";

function makeRunner() {
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  return { runner: { exec } as ExecRunner, exec };
}

const noopBroadcast = vi.fn();

beforeEach(() => {
  requireFreeSpace.mockReset();
  requireFreeSpace.mockResolvedValue(null);
  noopBroadcast.mockReset();
});

describe("writeContainerFile — disk-space guard", () => {
  it("refuses to write and never touches the container when the workspace is out of disk space", async () => {
    requireFreeSpace.mockResolvedValue("Error: not enough free disk space to write this file.");
    const { runner, exec } = makeRunner();

    const result = await writeContainerFile(runner, "/data/ws1", "notes.md", "hello", noopBroadcast);

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("not enough free disk space");
    expect(exec).not.toHaveBeenCalled();
    expect(noopBroadcast).not.toHaveBeenCalled();
  });

  it("sizes the check off the content being written", async () => {
    const { runner } = makeRunner();
    await writeContainerFile(runner, "/data/ws1", "notes.md", "hello", noopBroadcast);

    expect(requireFreeSpace).toHaveBeenCalledWith("/data/ws1", Buffer.byteLength("hello"));
  });

  it("proceeds to mkdir + tee when there's room, then broadcasts the change", async () => {
    const { runner, exec } = makeRunner();
    const result = await writeContainerFile(runner, "/data/ws1", "src/notes.md", "hello", noopBroadcast);

    expect(result).toBeNull();
    expect(exec).toHaveBeenCalledTimes(2); // mkdir -p, then tee
    expect(noopBroadcast).toHaveBeenCalledWith(JSON.stringify({ type: "files_changed", paths: ["src/notes.md"] }));
  });
});
