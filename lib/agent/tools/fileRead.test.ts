// file_read was the sharpest instance of the unbounded-capture bug: a plain `cat` with no
// offset/limit, whose result is then split/mapped/joined into three more full copies of itself. Two
// allowed tool calls — write a large file, then read it back — could exhaust the heap, and a heap
// exhaustion is an abort no try/catch can intercept. skipResultCap exempts this tool from the 50k
// dispatch cap, and that cap runs after materialization regardless, so nothing upstream helped.
//
// The fix stops the bytes in the container instead of transferring them to drop them, so these tests
// care about which command is issued, not only about what comes back.
import { describe, it, expect } from "vitest";
import { FileReadTool } from "./fileRead";
import type { ExecRunner, ExecResult } from "../interfaces";

function runnerReturning(result: Partial<ExecResult>): { runner: ExecRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  const runner: ExecRunner = {
    exec: async (cmd) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, cmds };
}

const read = (tool: FileReadTool, args: Record<string, unknown>) =>
  (tool as unknown as { _call: (a: Record<string, unknown>) => Promise<string> })._call(args);

describe("FileReadTool capture limits", () => {
  it("bounds the read inside the container rather than cat-ing the whole file", async () => {
    const { runner, cmds } = runnerReturning({ stdout: "hello\n" });
    await read(new FileReadTool(runner), { file_path: "notes.txt" });

    // The whole point: an oversized file must never cross into this process to begin with.
    expect(cmds[0][0]).toBe("head");
    expect(cmds[0]).not.toContain("cat");
    expect(cmds[0]).toContain("/workspace/notes.txt");
  });

  it("returns a normal file unchanged, with no truncation noise", async () => {
    const { runner } = runnerReturning({ stdout: "alpha\nbeta" });
    const out = await read(new FileReadTool(runner), { file_path: "notes.txt" });

    expect(out).toBe("notes.txt\n1\talpha\n2\tbeta");
    expect(out).not.toContain("truncated");
  });

  it("flags an over-limit file and names the way to read the rest", async () => {
    // One byte past the ceiling is what the tool asks for, so this stands in for "bigger than the cap".
    const { runner } = runnerReturning({ stdout: "x".repeat(400_001) });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log" });

    expect(out).toContain("file truncated at 400000 bytes");
    // Without a pointer to offset/limit the agent tends to retry the identical read and get nowhere.
    expect(out).toContain("offset:");
  });

  it("resumes ON the cut line, not past it", async () => {
    // Three lines where the third was cut mid-way by the byte ceiling. It is displayed as line 3,
    // whose 0-based offset is 2 — pointing at 3 would resume on line 4 and lose the rest of line 3
    // without a word, which is the exact silence this notice exists to prevent.
    const body = `alpha\nbeta\n${"g".repeat(400_000)}`;
    const { runner } = runnerReturning({ stdout: body });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log" });

    expect(out).toContain("offset: 2 ");
    expect(out).toContain("re-read");
  });

  it("resumes on the cut line for a range read too", async () => {
    const { runner } = runnerReturning({ stdout: "line11\nline12\nline13", truncated: true });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log", offset: 10, limit: 5 });

    // Rows shown are 0-based offsets 10, 11, 12; the cut one is 12.
    expect(out).toContain("offset: 12 ");
  });

  it("does not cry truncation for a file sitting exactly on the limit", async () => {
    const { runner } = runnerReturning({ stdout: "x".repeat(400_000) });
    const out = await read(new FileReadTool(runner), { file_path: "exact.log" });

    expect(out).not.toContain("truncated");
  });

  it("passes a range read through sed, and reports a ceiling hit on that path too", async () => {
    const { runner, cmds } = runnerReturning({ stdout: "line", truncated: true });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log", offset: 10, limit: 5 });

    expect(cmds[0][0]).toBe("sed");
    // A range can still be unbounded — limit omitted, or a huge limit over very long lines.
    expect(out).toContain("file truncated");
  });
});
