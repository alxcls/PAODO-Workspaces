// Egress invariant: after ensure(), the credproxy sidecar must be attached to the workspace network
// (otherwise the workspace can't resolve `credproxy` and all agent egress black-holes). These tests
// drive the ensure() wrapper with a stubbed _ensureContainer so they exercise verifyProxyAttached in
// isolation — covering the healthy, self-heal, and loud-failure paths regardless of how the container
// was brought up (create / resume-stopped / reattach-running).
import { describe, it, expect, beforeEach } from "vitest";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const SIDECAR = "paodo_ws_credproxy";

// The workspace store singleton is backed by a global map (survives module reloads). The proxy
// self-heal path only runs for an internet-on workspace, so seed one directly — a missing record
// now fails closed (no reattach) rather than defaulting to on.
function seedWorkspace(id: string, internetAccess: boolean) {
  const g = global as typeof global & { _workspaces?: Map<string, unknown> };
  if (!g._workspaces) g._workspaces = new Map();
  g._workspaces.set(id, { id, internetAccess });
}

// verifyProxyAttached only runs in "prod" (WORKSPACES_VOLUME_NAME set). Set it before importing the
// module so its module-level const captures the prod value, then import dynamically.
process.env.WORKSPACES_VOLUME_NAME = "paodo_ws_workspaces";
const { ContainerManager } = await import("./containerManager");

// Programmable docker mock. `attached` seeds whether `network inspect` reports the sidecar as an
// endpoint; a `network connect` with code 0 flips it to attached when `attachOnConnect` is set.
function makeDocker(opts: { attached: boolean; attachOnConnect: boolean; connectCode?: number }) {
  const calls: string[][] = [];
  let attached = opts.attached;
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        return { stdout: attached ? `${SIDECAR} ` : "", stderr: "", code: 0 };
      }
      if (args[0] === "network" && args[1] === "connect") {
        const code = opts.connectCode ?? 0;
        if (code === 0 && opts.attachOnConnect) attached = true;
        return { stdout: "", stderr: code ? "boom" : "", code };
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

const connectCalls = (calls: string[][]) => calls.filter((c) => c[0] === "network" && c[1] === "connect");

// Isolate the ensure() wrapper: stub the container bring-up so only verifyProxyAttached runs.
function makeManager(docker: IDockerClient) {
  const mgr = new ContainerManager(docker);
  (mgr as unknown as { _ensureContainer(id: string, dir: string): Promise<void> })._ensureContainer = async () => {};
  return mgr;
}

describe("ContainerManager proxy attachment invariant", () => {
  beforeEach(() => {
    seedWorkspace("ws1", true);
  });

  it("no-ops when the sidecar is already attached", async () => {
    const { docker, calls } = makeDocker({ attached: true, attachOnConnect: false });
    await makeManager(docker).ensure("ws1", "/w");
    expect(connectCalls(calls)).toHaveLength(0);
  });

  it("self-heals a dropped attachment by reconnecting the sidecar with its alias", async () => {
    const { docker, calls } = makeDocker({ attached: false, attachOnConnect: true });
    await expect(makeManager(docker).ensure("ws1", "/w")).resolves.toBeUndefined();
    const cc = connectCalls(calls);
    expect(cc).toHaveLength(1);
    expect(cc[0]).toEqual(["network", "connect", "--alias", "credproxy", "wsnet_ws1", SIDECAR]);
  });

  it("fails loudly when the sidecar cannot be reattached", async () => {
    const { docker } = makeDocker({ attached: false, attachOnConnect: false, connectCode: 1 });
    await expect(makeManager(docker).ensure("ws1", "/w")).rejects.toThrow(/not attached/);
  });
});

// ensure() and stop() must never run concurrently for the same workspace — a toggle's stop() racing
// an agent tool call's ensure() must not let the two interleave (e.g. stop() tearing the network down
// mid-reattach, or ensure() reattaching the sidecar right after stop() detached it).
describe("ContainerManager ensure()/stop() mutual exclusion", () => {
  beforeEach(() => {
    seedWorkspace("ws1", true);
  });

  // A docker mock where a chosen command (matched by its first arg) doesn't resolve until the test
  // explicitly releases it — lets us pin one operation "in flight" while starting a second.
  function makeGatedDocker(gatedCmd: string, order: string[]) {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const docker: IDockerClient = {
      cmd: async (...args: string[]): Promise<DockerResult> => {
        if (args[0] === gatedCmd) {
          order.push(`${gatedCmd}-start`);
          await gate;
          order.push(`${gatedCmd}-end`);
        }
        // Already attached, so ensure()'s post-_ensureContainer proxy.verify() no-ops and doesn't
        // add its own docker calls to the `order` timeline this test is asserting on.
        if (args[0] === "network" && args[1] === "inspect") return { stdout: SIDECAR, stderr: "", code: 0 };
        return OK;
      },
      build: async () => {},
      exec: async () => OK,
    };
    return { docker, release: () => release() };
  }

  it("makes stop() wait for an in-flight ensure() to finish before tearing the network down", async () => {
    const order: string[] = [];
    const { docker, release } = makeGatedDocker("start", order); // gate ensure()'s "docker start" call
    const mgr = new ContainerManager(docker);
    (mgr as unknown as { _ensureContainer(id: string, dir: string): Promise<void> })._ensureContainer = async () => {
      await docker.cmd("start", "wsnet_ws1"); // stands in for the real bring-up sequence
    };

    const ensureP = mgr.ensure("ws1", "/w");
    // Give ensure() a tick to register itself as the in-flight op before stop() checks startLocks.
    await new Promise((r) => setImmediate(r));
    const stopP = mgr.stop("ws1").then(() => order.push("stop-done"));

    release();
    await Promise.all([ensureP, stopP]);

    expect(order).toEqual(["start-start", "start-end", "stop-done"]);
  });

  it("makes ensure() wait out an in-flight stop() and then run its own fresh pass", async () => {
    const order: string[] = [];
    const { docker, release } = makeGatedDocker("stop", order); // gate stop()'s "docker stop" call
    const mgr = new ContainerManager(docker);
    let ensureCalls = 0;
    (mgr as unknown as { _ensureContainer(id: string, dir: string): Promise<void> })._ensureContainer = async () => {
      ensureCalls++;
      order.push("ensure-ran");
    };

    const stopP = mgr.stop("ws1");
    await new Promise((r) => setImmediate(r));
    const ensureP = mgr.ensure("ws1", "/w");

    release();
    await Promise.all([stopP, ensureP]);

    // ensure() must not resolve until AFTER stop()'s teardown finished, and it must have actually run
    // its own _ensureContainer pass afterward rather than piggybacking on stop()'s promise.
    expect(order).toEqual(["stop-start", "stop-end", "ensure-ran"]);
    expect(ensureCalls).toBe(1);
  });
});
