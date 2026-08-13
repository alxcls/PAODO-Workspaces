// Two guarantees about how command output leaves the container, both of them load-bearing.
//
// 1. A throw inside an output handler must not escape. Node invokes those handlers directly, so an
//    exception there is NOT caught by the promise chain around execStreaming — it lands on
//    server.ts's process-level uncaughtException guard, which fatal()s and exits. That is how an
//    unbounded `stdout += chunk` used to turn one workspace's noisy command into an instance-wide
//    outage. ExecOutput now caps the accumulation; this is the backstop behind it.
// 2. The overflow sink writes inside the container, capped and self-pruning, because the agent's
//    shell can only read paths that exist in there.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// A container that already exists and is running, so ensure() is a no-op fast path.
function makeDocker() {
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      if (args[0] === "inspect") return { stdout: "running", stderr: "", code: 0 };
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return docker;
}

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: PassThrough;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.kill = () => {};
  return proc;
}

beforeEach(() => {
  spawn.mockReset();
});

describe("execStreaming output handlers", () => {
  it("contains a throwing output handler instead of letting it kill the process", async () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const manager = new ContainerManager(makeDocker());

    const done = manager.execStreaming("ws1", "/w", ["/bin/bash", "-c", "cat huge.bin"], {
      // Stands in for any failure inside the consumer — the real one was RangeError from a string
      // that had grown past V8's limit.
      onStdout: () => {
        throw new RangeError("Invalid string length");
      },
      onStderr: () => {},
    });

    // execStreaming awaits ensure() before it spawns, so the handlers are not attached yet.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    // If the throw escaped, this emit would reject the test outright rather than being swallowed.
    expect(() => proc.stdout.emit("data", Buffer.from("boom"))).not.toThrow();
    proc.emit("close", 0);

    // The command still settles normally: one bad chunk degrades this command, nothing more.
    await expect(done).resolves.toEqual({ code: 0 });
  });
});

describe("openOutputSink", () => {
  function openSink() {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);
    const sink = new ContainerManager(makeDocker()).openOutputSink("ws1", "run-abc");
    return { sink, proc, args: spawn.mock.calls[0][1] as string[] };
  }

  it("writes into the container, where the agent's own shell can reach it", () => {
    const { sink, args } = openSink();

    expect(args.slice(0, 3)).toEqual(["exec", "-i", "ws_ws1"]);
    expect(sink.path).toBe("/tmp/paodo-exec/run-abc.output");
    // Alongside the background task logs, whose shape the agent is already told how to read.
    expect(sink.path.startsWith("/tmp/paodo-")).toBe(true);
  });

  it("caps the file and prunes old ones, so a container cannot fill up over its lifetime", () => {
    const { args } = openSink();
    const script = args[args.length - 1];

    // These containers are never auto-recreated, so nothing else would ever clear this directory.
    // Per-file cap × files kept is the number that matters: it is the most this feature can occupy
    // in a container's writable layer, which the workspace disk check cannot see and nothing but
    // destroying the container reclaims. 5 × 20MB.
    expect(script).toContain("tail -n +5");
    expect(script).toContain("rm -f");
    // ...but never a file still being written: the prune runs while other commands may be mid-spill,
    // and unlinking one of those takes away a path the agent was just told to go read.
    expect(script).toContain("-mmin +1");
    expect(script).toContain("head -c 20971520");
    expect(script).toContain("> /tmp/paodo-exec/run-abc.output");
  });

  it("forwards written chunks to the container", async () => {
    const { sink, proc } = openSink();
    const received: Buffer[] = [];
    proc.stdin.on("data", (c: Buffer) => received.push(c));

    sink.write(Buffer.from("first "));
    sink.write(Buffer.from("second"));
    await new Promise((r) => setImmediate(r));

    expect(Buffer.concat(received).toString()).toBe("first second");
  });

  it("strips anything shell-significant out of the run id", () => {
    const proc = fakeProc();
    spawn.mockReturnValue(proc);

    const sink = new ContainerManager(makeDocker()).openOutputSink("ws1", "abc; rm -rf /workspace #");
    const script = (spawn.mock.calls[0][1] as string[]).slice(-1)[0];

    // Separators, the semicolon and the comment marker are all gone — what is left is inert text.
    expect(sink.path).toBe("/tmp/paodo-exec/abcrm-rfworkspace.output");
    expect(script).not.toContain("rm -rf /workspace");
  });

  it("reports truncation rather than silently dropping the tail", () => {
    const { sink, proc } = openSink();

    // `head -c` exiting at the cap closes our stdin; the EPIPE that follows is the expected signal
    // that the file is full, and the notice the agent sees has to reflect that.
    proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(sink.truncated).toBe(true);
  });

  it("survives a sink that cannot be opened at all", () => {
    spawn.mockImplementation(() => {
      throw new Error("docker missing");
    });

    // Losing the saved copy is a degraded result; it must never be what breaks the command.
    const sink = new ContainerManager(makeDocker()).openOutputSink("ws1", "run-xyz");
    expect(() => {
      sink.write(Buffer.from("data"));
      sink.close();
    }).not.toThrow();
  });
});
