// Background-task lifecycle: startBackground launches a command DETACHED (its own setsid session,
// output to a log file) so the foreground exec timeout/escape kill can never reach it; stopBackground
// group-kills the recorded pgid; stop()/remove() clear the per-workspace bookkeeping.
import { describe, it, expect, beforeEach } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Records every exec() invocation and answers the pidfile poll with a canned pgid, so we can assert
// on the exact in-container commands startBackground/stopBackground issue.
function makeDocker(pgid = "4242"): { docker: IDockerClient; execCalls: string[][] } {
  const execCalls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async () => OK,
    build: async () => {},
    exec: async (_name, cmdArgs) => {
      execCalls.push(cmdArgs);
      const script = cmdArgs.join(" ");
      // The pidfile poll is the only exec whose stdout matters — return the session-leader pgid.
      if (script.includes("seq 1 20")) return { stdout: pgid, stderr: "", code: 0 };
      return OK;
    },
  };
  return { docker, execCalls };
}

function makeManager(pgid = "4242") {
  const { docker, execCalls } = makeDocker(pgid);
  const mgr = new ContainerManager(docker);
  // ensure() spins up a real container; the background logic under test doesn't need that.
  mgr.ensure = async () => {};
  return { mgr, execCalls };
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
    expect(launchScript).toContain(logFile);            // output redirected to the log file
    expect(launchScript).toMatch(/&\s*$/);              // backgrounded so the exec returns at once
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
    expect(kill[2]).toContain("kill -KILL -4242");      // negative pgid → kills the whole group
    expect(mgr.listBackground("ws1")).toHaveLength(0);
  });

  it("stopBackground returns false for an unknown taskId", async () => {
    expect(await mgr.stopBackground("ws1", "nope")).toBe(false);
  });

  it("does not track a task when the pid was never captured", async () => {
    const { mgr: m } = makeManager("");                 // poll returns empty → no pgid
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
});
