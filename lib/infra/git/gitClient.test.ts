// GitClient is the second spawner, and it inherited the unbounded capture from the first: its header
// says it "mirrors dockerClient._spawn", and capping dockerClient did nothing for it. It is
// agent-reachable in one tool call — the agent writes a large file, the automatic post-run snapshot
// commits it, and workspace_history diffs it, producing stdout proportional to what was written. A
// RangeError from `stdout +=` in a "data" handler does not reject this promise; it reaches server.ts's
// uncaughtException guard and exits the instance.
//
// So what these tests pin is that this spawner is bounded by the SAME ceiling as the other one, and
// that the two diff paths say when they were cut instead of returning a prefix that reads as complete.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const { GitClient } = await import("./gitClient");
const { WorkspaceVersioning } = await import("./workspaceVersioning");

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: PassThrough;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new PassThrough();
  return proc;
}

beforeEach(() => spawn.mockReset());

describe("GitClient output capture", () => {
  it("keeps ordinary git output whole and does not flag it", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new GitClient().run(["status", "--porcelain"]);
    proc.stdout.emit("data", Buffer.from(" M lib/app.ts\n"));
    proc.emit("close", 0);

    expect(await p).toEqual({ stdout: "M lib/app.ts", stderr: "", code: 0, truncated: false });
  });

  it("stops capturing at the ceiling instead of growing without bound", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new GitClient().run(["diff", "HEAD~1", "HEAD"], { trimStdout: false });
    // 64MB of diff — one large file the agent wrote, snapshotted and then diffed.
    for (let i = 0; i < 64; i++) proc.stdout.emit("data", Buffer.alloc(1024 * 1024, 0x2b));
    proc.emit("close", 0);

    const r = await p;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBe(8 * 1024 * 1024);
  });

  it("still reports a spawn failure rather than throwing", async () => {
    // Once, not permanently: a throwing implementation left in place outlives the call and gets
    // re-entered during teardown, which surfaces as this test failing on an error it already handled.
    spawn.mockImplementationOnce(() => {
      throw new Error("git not found");
    });

    await expect(new GitClient().run(["--version"])).resolves.toMatchObject({ code: 1, stderr: "git not found" });
  });
});

describe("WorkspaceVersioning diffs", () => {
  function versioningOver(result: { stdout: string; truncated?: boolean }) {
    const git = { run: vi.fn().mockResolvedValue({ stderr: "", code: 0, ...result }) };
    return new WorkspaceVersioning(git, { rootDir: "/tmp/versioning-test" });
  }

  it("returns a whole diff unannotated", async () => {
    const v = versioningOver({ stdout: "@@ -1 +1 @@\n-a\n+b\n", truncated: false });

    expect(await v.diff("ws1", "/w", "a", "b")).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });

  it("says so when the diff was cut, rather than passing off a prefix as the whole change", async () => {
    const v = versioningOver({ stdout: "@@ -1 +1 @@\n-a\n", truncated: true });

    // A silently-truncated diff is worse than a short one: it reads as "and nothing else changed".
    expect(await v.versionDiff("ws1", "/w", "abc123")).toContain("[diff truncated");
  });
});
