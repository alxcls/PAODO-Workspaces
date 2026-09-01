// Background-task lifecycle: startBackground launches a command DETACHED (its own setsid session,
// output to a log file) so the foreground exec timeout/escape kill can never reach it; stopBackground
// group-kills the recorded pgid; stop()/remove() clear the per-workspace bookkeeping.
import { describe, it, expect, beforeEach } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Records every exec() invocation and answers the pidfile poll with a canned pgid, so we can assert
// on the exact in-container commands startBackground/stopBackground issue. `scanOut` answers the
// rehydration scan (the exec whose script does the `kill -0` liveness check over the pidfiles).
function makeDocker(opts: { pgid?: string; scanOut?: string } = {}): { docker: IDockerClient; execCalls: string[][] } {
  const { pgid = "4242", scanOut } = opts;
  const execCalls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async () => OK,
    build: async () => {},
    exec: async (_name, cmdArgs) => {
      execCalls.push(cmdArgs);
      const script = cmdArgs.join(" ");
      // The pidfile poll is the only exec whose stdout matters — return the session-leader pgid.
      if (script.includes("seq 1 20")) return { stdout: pgid, stderr: "", code: 0 };
      // The rehydration scan: return the canned "taskId\tpgid\tbase64(cmd)" lines.
      if (script.includes("kill -0")) return { stdout: scanOut ?? "", stderr: "", code: 0 };
      return OK;
    },
  };
  return { docker, execCalls };
}

// Encode a command the way the container's scan does, so rehydration tests decode it back.
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

// The scan emits "taskId<TAB>pgid<TAB>startedSec<TAB>base64(command)". STARTED_SEC is recent so the
// per-task cap never trips in these rehydration tests.
const STARTED_SEC = Math.floor(Date.now() / 1000);
function taskLine(id: string, pgid: number, cmd: string): string {
  return `${id}\t${pgid}\t${STARTED_SEC}\t${b64(cmd)}`;
}

function makeManager(opts: { pgid?: string; scanOut?: string } = {}) {
  const { docker, execCalls } = makeDocker(opts);
  const mgr = new ContainerManager(docker);
  // ensure() spins up a real container; the background logic under test doesn't need that.
  mgr.ensure = async () => {};
  return { mgr, execCalls };
}

// Rehydration lives on the BackgroundTaskManager collaborator (invoked from the reattach path in
// _ensureContainer); reach it directly so these unit tests don't have to stand up the whole
// container-status state machine.
function rehydrate(mgr: ContainerManager, workspaceId: string): Promise<void> {
  return (mgr as unknown as { background: { rehydrate(id: string): Promise<void> } }).background.rehydrate(workspaceId);
}

describe("ContainerManager background tasks", () => {
  let mgr: ContainerManager;
  let execCalls: string[][];
  beforeEach(() => {
    ({ mgr, execCalls } = makeManager());
  });

  it("launches detached via setsid to a log file and returns a taskId + log path", async () => {
    const { taskId, logFile } = await mgr.startBackground("ws1", "/w", "python3 -m http.server 8080");

    expect(taskId).toBeTruthy();
    expect(logFile).toBe(`/tmp/paodo-tasks/${taskId}.output`);

    const launch = execCalls.find((c) => c.join(" ").includes("setsid"))!;
    const launchScript = launch[2];
    expect(launchScript).toContain("setsid");
    expect(launchScript).toContain(logFile); // output redirected to the log file
    expect(launchScript).toMatch(/&\s*$/); // backgrounded so the exec returns at once
    // The user command is passed as an argv positional ($1), never string-interpolated (no injection).
    expect(launch).toContain("python3 -m http.server 8080");
    expect(launchScript).not.toContain("python3 -m http.server 8080");
  });

  it("tracks the started task with its self-reported pgid, visible via listBackground", async () => {
    const { taskId } = await mgr.startBackground("ws1", "/w", "npm run dev");
    const tasks = mgr.listBackground("ws1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId, pgid: 4242, command: "npm run dev" });
  });

  it("stopBackground group-kills the recorded pgid (negative pid) and clears the entry", async () => {
    const { taskId } = await mgr.startBackground("ws1", "/w", "npm run dev");
    const stopped = await mgr.stopBackground("ws1", taskId);

    expect(stopped).toBe(true);
    const kill = execCalls.find((c) => c.join(" ").includes("kill -KILL"))!;
    expect(kill[2]).toContain("kill -KILL -4242"); // negative pgid → kills the whole group
    expect(mgr.listBackground("ws1")).toHaveLength(0);
  });

  it("stopBackground returns false for an unknown taskId", async () => {
    expect(await mgr.stopBackground("ws1", "nope")).toBe(false);
  });

  it("does not track a task when the pid was never captured", async () => {
    const { mgr: m } = makeManager({ pgid: "" }); // poll returns empty → no pgid
    await m.startBackground("ws1", "/w", "false");
    expect(m.listBackground("ws1")).toHaveLength(0);
  });

  it("clears the workspace's background bookkeeping on stop() and remove()", async () => {
    await mgr.startBackground("ws1", "/w", "npm run dev");
    await mgr.stop("ws1");
    expect(mgr.listBackground("ws1")).toHaveLength(0);

    await mgr.startBackground("ws2", "/w", "npm run dev");
    await mgr.remove("ws2");
    expect(mgr.listBackground("ws2")).toHaveLength(0);
  });

  it("keeps tasks isolated per workspace", async () => {
    await mgr.startBackground("ws1", "/w", "server A");
    await mgr.startBackground("ws2", "/w", "server B");
    expect(mgr.listBackground("ws1")).toHaveLength(1);
    expect(mgr.listBackground("ws2")).toHaveLength(1);
    expect(mgr.listBackground("ws1")[0].command).toBe("server A");
  });

  it("records the command to a .cmd file so it survives an app restart", async () => {
    const { taskId } = await mgr.startBackground("ws1", "/w", "npm run dev");
    const launch = execCalls.find((c) => c.join(" ").includes("setsid"))!;
    // printf '%s' "$1" writes the command (argv, no injection) to <taskId>.cmd.
    expect(launch[2]).toContain(`printf '%s' "$1" > /tmp/paodo-tasks/${taskId}.cmd`);
  });

  it("stopBackground removes both the .pid and .cmd files", async () => {
    const { taskId } = await mgr.startBackground("ws1", "/w", "npm run dev");
    await mgr.stopBackground("ws1", taskId);
    const kill = execCalls.find((c) => c.join(" ").includes("kill -KILL"))!;
    expect(kill[2]).toContain(`${taskId}.pid`);
    expect(kill[2]).toContain(`${taskId}.cmd`);
  });

  it("stopBackground still succeeds and clears the entry when the kill exec fails (dead pgid)", async () => {
    const { docker } = makeDocker();
    docker.exec = async (_n, args) => {
      const script = args.join(" ");
      if (script.includes("seq 1 20")) return { stdout: "4242", stderr: "", code: 0 };
      if (script.includes("kill -KILL")) throw new Error("no such process group");
      return OK;
    };
    const m = new ContainerManager(docker);
    m.ensure = async () => {};
    const { taskId } = await m.startBackground("ws1", "/w", "npm run dev");
    expect(await m.stopBackground("ws1", taskId)).toBe(true);
    expect(m.listBackground("ws1")).toHaveLength(0);
  });
});

describe("ContainerManager stop result", () => {
  function managerWithStop(result: DockerResult): ContainerManager {
    const docker: IDockerClient = {
      cmd: async (...args) => (args[0] === "stop" ? result : OK),
      build: async () => {},
      exec: async () => OK,
    };
    return new ContainerManager(docker);
  }

  it("rejects when Docker cannot stop a possibly running container", async () => {
    const manager = managerWithStop({ stdout: "", stderr: "Cannot connect to the Docker daemon", code: 1 });

    await expect(manager.stop("ws1")).rejects.toThrow("docker stop failed");
  });

  it("treats an absent container as already stopped", async () => {
    const manager = managerWithStop({ stdout: "", stderr: "No such container: ws_ws1", code: 1 });

    await expect(manager.stop("ws1")).resolves.toBeUndefined();
  });
});

describe("ContainerManager remove result", () => {
  function managerWithResults(results: Partial<Record<string, DockerResult>> = {}): {
    manager: ContainerManager;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const docker: IDockerClient = {
      cmd: async (...args) => {
        calls.push(args);
        const key = args[0] === "network" ? `${args[0]} ${args[1]}` : args[0];
        return results[key] ?? OK;
      },
      build: async () => {},
      exec: async () => OK,
    };
    return { manager: new ContainerManager(docker), calls };
  }

  it("treats explicitly absent containers and networks as already removed", async () => {
    const missingContainer = { stdout: "", stderr: "No such container: ws_ws1", code: 1 };
    const { manager } = managerWithResults({
      stop: missingContainer,
      rm: missingContainer,
      "network rm": { stdout: "", stderr: "network wsnet_ws1 not found", code: 1 },
    });

    await expect(manager.remove("ws1")).resolves.toBeUndefined();
  });

  it.each([
    ["stop", "Cannot connect to the Docker daemon"],
    ["rm", "permission denied"],
    ["network rm", "network has active endpoints"],
  ])("rejects a real %s failure after still attempting the remaining cleanup", async (failedCommand, stderr) => {
    const { manager, calls } = managerWithResults({
      [failedCommand]: { stdout: "", stderr, code: 1 },
    });

    await expect(manager.remove("ws1")).rejects.toThrow("workspace Docker cleanup failed");
    expect(calls).toContainEqual(["stop", "ws_ws1"]);
    expect(calls).toContainEqual(["rm", "ws_ws1"]);
    expect(calls).toContainEqual(["network", "rm", "wsnet_ws1"]);
  });

  it("rejects a container restart once permanent removal has begun", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const docker: IDockerClient = {
      cmd: async (...args) => {
        if (args[0] === "stop") await stopGate;
        return OK;
      },
      build: async () => {},
      exec: async () => OK,
    };
    const manager = new ContainerManager(docker);
    const remove = manager.remove("ws1");
    await new Promise((resolve) => setImmediate(resolve));

    await expect(manager.ensure("ws1", "/workspace/ws1")).rejects.toThrow("being permanently deleted");

    releaseStop();
    await expect(remove).resolves.toBeUndefined();
    await expect(manager.ensure("ws1", "/workspace/ws1")).rejects.toThrow("being permanently deleted");
  });
});

// Rehydration: after an app restart the in-memory map is empty but the workspace container and its
// servers keep running. Rebuilding from the container's pidfiles makes a survivor server visible
// again — surfaced in the agent's context and stoppable — instead of colliding invisibly.
describe("ContainerManager background-task rehydration", () => {
  it("rebuilds the map from the container's live pidfiles (decoding the base64 command)", async () => {
    const scanOut = `${taskLine("task-aaa", 7001, "npm run dev")}\n${taskLine("task-bbb", 7002, "python3 -m http.server 8080")}`;
    const { mgr } = makeManager({ scanOut });

    expect(mgr.listBackground("ws1")).toHaveLength(0); // map starts empty (as after a restart)
    await rehydrate(mgr, "ws1");

    const tasks = mgr.listBackground("ws1");
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.taskId === "task-aaa")).toMatchObject({
      pgid: 7001,
      command: "npm run dev",
      logFile: "/tmp/paodo-tasks/task-aaa.output",
    });
    expect(tasks.find((t) => t.taskId === "task-bbb")?.command).toBe("python3 -m http.server 8080");
  });

  it("makes a rehydrated task stoppable via stopBackground", async () => {
    const { mgr } = makeManager({ scanOut: taskLine("task-aaa", 7001, "npm run dev") });
    await rehydrate(mgr, "ws1");
    expect(await mgr.stopBackground("ws1", "task-aaa")).toBe(true);
    expect(mgr.listBackground("ws1")).toHaveLength(0);
  });

  it("falls back to a placeholder command when the .cmd file is missing", async () => {
    const { mgr } = makeManager({ scanOut: `task-aaa\t7001\t${STARTED_SEC}\t` }); // empty base64 field
    await rehydrate(mgr, "ws1");
    expect(mgr.listBackground("ws1")[0].command).toContain("unknown");
  });

  it("scans only once per workspace per process-lifetime", async () => {
    const { mgr, execCalls } = makeManager({ scanOut: taskLine("task-aaa", 7001, "npm run dev") });
    await rehydrate(mgr, "ws1");
    await rehydrate(mgr, "ws1");
    const scans = execCalls.filter((c) => c.join(" ").includes("kill -0"));
    expect(scans).toHaveLength(1);
  });

  it("re-scans after stop() clears the once-guard", async () => {
    const { mgr, execCalls } = makeManager({ scanOut: taskLine("task-aaa", 7001, "npm run dev") });
    await rehydrate(mgr, "ws1");
    await mgr.stop("ws1");
    await rehydrate(mgr, "ws1");
    const scans = execCalls.filter((c) => c.join(" ").includes("kill -0"));
    expect(scans).toHaveLength(2);
  });

  it("leaves the map empty when no live pidfiles are found", async () => {
    const { mgr } = makeManager({ scanOut: "" });
    await rehydrate(mgr, "ws1");
    expect(mgr.listBackground("ws1")).toHaveLength(0);
  });
});
