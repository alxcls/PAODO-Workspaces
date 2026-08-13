// DockerClient._spawn is the chokepoint every non-streaming tool funnels through — file_read,
// glob, list_directory, file_edit, file_write, apt_install, web_fetch and the rest. Its capture used
// to be an unbounded `stdout += d.toString()` in a stream handler, which is the same defect that made
// execCommand able to take the process down, but shared by nine tools instead of one.
//
// A throw in these handlers does not reject the promise this class returns: Node calls them directly,
// so it lands on server.ts's uncaughtException guard and exits. The ceiling is what keeps that
// unreachable, so what these tests pin is that it holds and that it is reported honestly.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const { DockerClient } = await import("./dockerClient");

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

describe("DockerClient output capture", () => {
  it("keeps modest output whole and does not flag it", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["cat", "small.txt"]);
    proc.stdout.emit("data", Buffer.from("file contents"));
    proc.emit("close", 0);

    expect(await p).toEqual({ stdout: "file contents", stderr: "", code: 0, truncated: false });
  });

  it("stops capturing at the ceiling instead of growing without bound", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["cat", "huge.bin"]);
    // 64MB in 1MB chunks — the "write a large file, read it back" path, in two tool calls.
    for (let i = 0; i < 64; i++) proc.stdout.emit("data", Buffer.alloc(1024 * 1024, 0x61));
    proc.emit("close", 0);

    const r = await p;
    expect(r.truncated).toBe(true);
    // Held at the 8MB ceiling rather than the 64MB that was produced.
    expect(Buffer.byteLength(r.stdout)).toBe(8 * 1024 * 1024);
  });

  it("caps stderr on its own budget, so a noisy failure cannot slip past", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const p = new DockerClient().exec("ws_1", ["false"]);
    for (let i = 0; i < 16; i++) proc.stderr.emit("data", Buffer.alloc(1024 * 1024, 0x62));
    proc.emit("close", 1);

    const r = await p;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stderr)).toBe(8 * 1024 * 1024);
  });

  it("still reports a spawn failure rather than throwing", async () => {
    // Once, not permanently: a throwing implementation left in place outlives the call and gets
    // re-entered during teardown, which surfaces as this test failing on an error it already handled.
    spawn.mockImplementationOnce(() => {
      throw new Error("EBADF");
    });

    // Pre-existing behaviour worth keeping: spawn can throw synchronously during Next compilation.
    await expect(new DockerClient().exec("ws_1", ["ls"])).resolves.toMatchObject({ code: 1, stderr: "EBADF" });
  });
});
