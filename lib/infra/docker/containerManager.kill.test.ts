/**
 * Killing a foreground command is a two-step escalation, not a single SIGKILL.
 *
 * Commands are killed routinely and without anyone asking — the silence guard, the max-runtime cap,
 * the mid-run disk check, and the user's Stop all land here. SIGKILL cannot be caught, so a command
 * killed that way never runs its own cleanup: git keeps its index.lock, npm keeps a half-written
 * staging dir, and the agent spends its next turns repairing that. SIGTERM first gives the process
 * group the chance to do it properly; SIGKILL still follows for anything that ignores the request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ContainerManager } from "./containerManager";
import { EXEC_KILL_GRACE_MS } from "../limits";
import type { IDockerClient, DockerResult } from "./dockerClient";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Records the in-container commands so a test can assert which signal was sent, and when.
function makeDocker(): { docker: IDockerClient; execScripts: string[] } {
  const execScripts: string[] = [];
  const docker: IDockerClient = {
    cmd: async (): Promise<DockerResult> => OK,
    build: async () => {},
    exec: async (_name, cmdArgs) => {
      execScripts.push(cmdArgs.join(" "));
      return OK;
    },
  };
  return { docker, execScripts };
}

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

// Starts a command wired to an abort signal and lets execStreaming get as far as spawning. ensure()
// is stubbed: its network reconciliation does not survive fake timers, and the kill path starts after it.
async function startCommand(preAborted = false) {
  const proc = fakeProc();
  spawn.mockReturnValue(proc);
  const { docker, execScripts } = makeDocker();
  const controller = new AbortController();
  if (preAborted) controller.abort();

  const manager = new ContainerManager(docker);
  manager.ensure = async () => {};

  const done = manager.execStreaming("ws1", "/w", ["/bin/bash", "-c", "sleep 999"], {
    onStdout: () => {},
    onStderr: () => {},
    signal: controller.signal,
  });
  // One microtask turn past `await this.ensure()`, which is where the spawn happens.
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalled();
  return { proc, controller, execScripts, done };
}

// Both the abort listener and the fake docker client run synchronously, so a signal is recorded by
// the time abort() returns — no waiting involved.
const signalsSent = (scripts: string[]) =>
  scripts.filter((s) => /kill -(TERM|KILL)/.test(s)).map((s) => (s.includes("kill -TERM") ? "TERM" : "KILL"));

beforeEach(() => {
  spawn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("execStreaming kill escalation", () => {
  it("asks with SIGTERM first and does not drop the host-side client yet", async () => {
    const { proc, controller, execScripts } = await startCommand();

    controller.abort();

    expect(signalsSent(execScripts)).toEqual(["TERM"]);
    // Dropping the docker exec client here would orphan the command onto PID 1 while its group is
    // still alive — the exact failure the pid-file group kill exists to prevent.
    expect(proc.kill).not.toHaveBeenCalled();
    // The pid file has to survive: the escalation still needs to read the pgid out of it.
    expect(execScripts.some((s) => s.includes("rm -f"))).toBe(false);
  });

  it("escalates to SIGKILL once the grace period expires", async () => {
    const { proc, controller, execScripts } = await startCommand();

    controller.abort();
    await vi.advanceTimersByTimeAsync(EXEC_KILL_GRACE_MS);

    expect(signalsSent(execScripts)).toEqual(["TERM", "KILL"]);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    // Last signal this command will ever get, so the pid file goes with it.
    expect(execScripts.some((s) => s.includes("kill -KILL") && s.includes("rm -f"))).toBe(true);
  });

  it("still escalates after a clean exit — a closed client is not an empty process group", async () => {
    const { proc, controller, execScripts, done } = await startCommand();

    controller.abort();
    // `setsid --wait` returns when the group LEADER exits, so this close says the leader honoured
    // SIGTERM — nothing about a sibling that blocked it and is still in the group.
    proc.emit("close", 0);
    await expect(done).resolves.toEqual({ code: 0 });

    await vi.advanceTimersByTimeAsync(EXEC_KILL_GRACE_MS);
    expect(signalsSent(execScripts)).toEqual(["TERM", "KILL"]);
  });

  it("signals nothing at all for a command that was never killed", async () => {
    const { proc, execScripts, done } = await startCommand();

    proc.emit("close", 0);
    await expect(done).resolves.toEqual({ code: 0 });

    // Only the kill path arms the escalation, so a command left to finish is never signalled.
    await vi.advanceTimersByTimeAsync(EXEC_KILL_GRACE_MS * 2);
    expect(signalsSent(execScripts)).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("still escalates for a signal that was already aborted before the call", async () => {
    const { execScripts } = await startCommand(true);

    expect(signalsSent(execScripts)).toEqual(["TERM"]);
    await vi.advanceTimersByTimeAsync(EXEC_KILL_GRACE_MS);
    expect(signalsSent(execScripts)).toEqual(["TERM", "KILL"]);
  });
});

// A pid file is removed only when a command is KILLED, so every command that simply finishes leaves
// one behind. Containers live as long as their workspace and nothing else clears their /tmp.
describe("orphaned exec pid file sweep", () => {
  // Drives _ensureContainer down one branch by answering the status probe, and records what ran.
  async function ensureWithStatus(status: "running" | "stopped"): Promise<string[]> {
    const execScripts: string[] = [];
    const docker: IDockerClient = {
      cmd: async (...args: string[]): Promise<DockerResult> => {
        if (args[0] === "inspect") return { stdout: status, stderr: "", code: 0 };
        return OK;
      },
      build: async () => {},
      exec: async (_name, cmdArgs) => {
        execScripts.push(cmdArgs.join(" "));
        return OK;
      },
    };
    const manager = new ContainerManager(docker);
    await manager.ensure("ws1", "/w");
    return execScripts;
  }

  const sweeps = (scripts: string[]) => scripts.filter((s) => s.includes("paodo-exec-*.pid"));

  it("clears them when a stopped container is restarted", async () => {
    const scripts = await ensureWithStatus("stopped");

    expect(sweeps(scripts)).toHaveLength(1);
    // `find -delete`, not a glob handed to rm: a long-neglected container could hold enough files
    // to blow ARG_MAX, and the sweep is the one thing that must not fail on a full directory.
    expect(sweeps(scripts)[0]).toContain("-delete");
  });

  it("leaves them alone when reattaching to a still-running container", async () => {
    // The app restarted but the container did not, so a pid file here may belong to a live command.
    expect(sweeps(await ensureWithStatus("running"))).toHaveLength(0);
  });
});
