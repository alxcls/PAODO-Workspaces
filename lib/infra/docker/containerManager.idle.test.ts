/**
 * Task-aware idle reaping. A container is kept warm while a run is active OR at least one background
 * task is verified-alive, and stopped only once both clear. Each task carries its own 24h cap so no
 * single process keeps a container up forever. The idle timer is anchored to run start/end (not to
 * per-exec activity), so it can never fire mid-run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const IDLE_MS = 2 * 60 * 1000; // idle window
const POLL_MS = 60 * 1000; // task-liveness poll
const MAX_MS = 24 * 60 * 60 * 1000; // per-task hard cap

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

// `scan` returns what the pidfile scan reports (a test can change it between polls). cmdCalls records
// docker.cmd (stop lives here); execScripts records in-container scripts (the scan and any kills).
function makeManager(scan: () => string) {
  const cmdCalls: string[][] = [];
  const execScripts: string[] = [];
  const docker: IDockerClient = {
    cmd: async (...args) => {
      cmdCalls.push(args);
      return OK;
    },
    build: async () => {},
    exec: async (_name, cmdArgs) => {
      const script = cmdArgs.join(" ");
      execScripts.push(script);
      if (script.includes("kill -0")) return { stdout: scan(), stderr: "", code: 0 };
      return OK;
    },
  };
  const mgr = new ContainerManager(docker);
  mgr.ensure = async () => {};
  return { mgr, cmdCalls, execScripts };
}

const stopped = (cmdCalls: string[][]) => cmdCalls.some((c) => c[0] === "stop");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("task-aware idle reaping", () => {
  it("stops the container after the base window once a run ends with no live task", async () => {
    const { mgr, cmdCalls } = makeManager(() => "");
    mgr.noteRunStart("ws1");
    mgr.noteRunEnd("ws1");
    await vi.advanceTimersByTimeAsync(0); // let the reaper's reconcile arm its timer

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(stopped(cmdCalls)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(cmdCalls).toContainEqual(["stop", "ws_ws1"]);
  });

  it("never stops while a run is still active, however long it runs", async () => {
    const { mgr, cmdCalls } = makeManager(() => "");
    mgr.noteRunStart("ws1");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(stopped(cmdCalls)).toBe(false);
  });

  it("nested runs keep it warm until the last one ends", async () => {
    const { mgr, cmdCalls } = makeManager(() => "");
    mgr.noteRunStart("ws1");
    mgr.noteRunStart("ws1"); // a call_agent sub-run on the same workspace
    mgr.noteRunEnd("ws1");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(stopped(cmdCalls)).toBe(false); // one run still active

    mgr.noteRunEnd("ws1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stopped(cmdCalls)).toBe(true);
  });

  it("keeps a container with a live task warm, then idles once the task exits", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let scan = `task-aaa\t7001\t${nowSec}\t${b64("npm run dev")}`;
    const { mgr, cmdCalls } = makeManager(() => scan);

    mgr.noteRunStart("ws1");
    mgr.noteRunEnd("ws1");
    await vi.advanceTimersByTimeAsync(0);

    // While the task is alive the reaper polls but never stops — well past the base idle window.
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(stopped(cmdCalls)).toBe(false);

    // Task exits: the next poll finds nothing live and arms the base idle window.
    scan = "";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(stopped(cmdCalls)).toBe(false);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(cmdCalls).toContainEqual(["stop", "ws_ws1"]);
  });
});

describe("per-task 24h cap", () => {
  it("group-kills a task past its cap and drops it from the tracked list", async () => {
    const overCapSec = Math.floor((Date.now() - MAX_MS - 1000) / 1000);
    const { mgr, execScripts } = makeManager(() => `task-old\t9100\t${overCapSec}\t${b64("python3 -m http.server")}`);

    const survivors = await mgr.reconcileBackgroundTasks("ws1");
    expect(survivors).toHaveLength(0);
    expect(execScripts.some((s) => s.includes("kill -KILL -9100"))).toBe(true);
    expect(mgr.listBackground("ws1")).toHaveLength(0);
  });

  it("keeps a task still within its cap", async () => {
    const freshSec = Math.floor((Date.now() - 60_000) / 1000);
    const { mgr, execScripts } = makeManager(() => `task-new\t9200\t${freshSec}\t${b64("npm run dev")}`);

    const survivors = await mgr.reconcileBackgroundTasks("ws1");
    expect(survivors.map((t) => t.taskId)).toEqual(["task-new"]);
    expect(execScripts.some((s) => s.includes("kill -KILL"))).toBe(false);
  });

  it("prunes a task that is no longer in the live scan", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let scan = `task-a\t101\t${nowSec}\t${b64("a")}\ntask-b\t102\t${nowSec}\t${b64("b")}`;
    const { mgr } = makeManager(() => scan);

    expect(await mgr.reconcileBackgroundTasks("ws1")).toHaveLength(2);
    scan = `task-a\t101\t${nowSec}\t${b64("a")}`; // task-b exited
    const survivors = await mgr.reconcileBackgroundTasks("ws1");
    expect(survivors.map((t) => t.taskId)).toEqual(["task-a"]);
  });
});
