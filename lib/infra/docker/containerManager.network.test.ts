// ensureNetwork is the network-layer half of the internet-access toggle: it must create the
// workspace's network with --internal when access is off, and — since Docker can't flip --internal
// on an existing network — detect and repair a stale network whose flag doesn't match the current
// policy. Reached directly (private method) so these tests don't have to drive the full
// _ensureContainer state machine (image hash, secrets, container run) just to exercise this logic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Docker stub for the lazy network sweep: `network ls` lists the given networks and `network inspect
// --format {{len .Containers}}` reports each one's attached-endpoint count, so a test can mark a
// network empty (0) or in-use (> 0). Every `network rm` is recorded.
function makeSweepDocker(counts: Record<string, number>) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "network" && args[1] === "ls") {
        return { stdout: Object.keys(counts).join("\n"), stderr: "", code: 0 };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        const name = args[2];
        if (!(name in counts)) return { stdout: "", stderr: "no such network", code: 1 };
        return { stdout: String(counts[name]), stderr: "", code: 0 };
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  const rmTargets = () => calls.filter((c) => c[0] === "network" && c[1] === "rm").map((c) => c[2]);
  return { docker, calls, rmTargets };
}

function makeDocker(opts: { inspectCode?: number; internal?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "network" && args[1] === "inspect") {
        const code = opts.inspectCode ?? 1; // default: network doesn't exist yet
        return { stdout: code === 0 ? String(!!opts.internal) : "", stderr: "", code };
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

function ensureNetwork(mgr: ContainerManager, workspaceId: string, internetAccess: boolean): Promise<void> {
  return (mgr as unknown as { ensureNetwork(id: string, internetAccess: boolean): Promise<void> }).ensureNetwork(
    workspaceId,
    internetAccess,
  );
}

describe("ContainerManager.ensureNetwork — creation", () => {
  it("creates a plain bridge network when internet access is on", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 1 });
    await ensureNetwork(new ContainerManager(docker), "ws1", true);
    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).toBeDefined();
    expect(create).not.toContain("--internal");
    expect(create).toContain("com.paodo.managed=workspace");
    expect(create).toContain("com.paodo.workspace-id=ws1");
  });

  it("creates an --internal network when internet access is off", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 1 });
    await ensureNetwork(new ContainerManager(docker), "ws1", false);
    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).toBeDefined();
    expect(create).toContain("--internal");
  });
});

describe("ContainerManager.ensureNetwork — existing network, flag matches", () => {
  it("no-ops when an on-policy workspace's network is already non-internal", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 0, internal: false });
    await ensureNetwork(new ContainerManager(docker), "ws1", true);
    expect(calls.some((c) => c[0] === "network" && (c[1] === "create" || c[1] === "rm"))).toBe(false);
  });

  it("no-ops when an off-policy workspace's network is already --internal", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 0, internal: true });
    await ensureNetwork(new ContainerManager(docker), "ws1", false);
    expect(calls.some((c) => c[0] === "network" && (c[1] === "create" || c[1] === "rm"))).toBe(false);
  });
});

describe("ContainerManager.ensureNetwork — existing network, flag mismatch", () => {
  it("recreates a non-internal network as --internal when policy flipped to off", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 0, internal: false });
    await ensureNetwork(new ContainerManager(docker), "ws1", false);
    const rm = calls.find((c) => c[0] === "network" && c[1] === "rm");
    const create = calls.find((c) => c[0] === "network" && c[1] === "create");
    expect(rm).toBeDefined();
    expect(create).toBeDefined();
    expect(create).toContain("--internal");
    // rm must come before create — recreating in the wrong order would race Docker's "name in use".
    expect(calls.indexOf(rm!)).toBeLessThan(calls.indexOf(create!));
  });

  it("recreates an --internal network as non-internal when policy flipped to on", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 0, internal: true });
    await ensureNetwork(new ContainerManager(docker), "ws1", true);
    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).toBeDefined();
    expect(create).not.toContain("--internal");
  });

  it("force-disconnects the workspace container and the proxy sidecar before removing the network", async () => {
    // A container/sidecar that reached this state without a clean stop() can still hold an endpoint,
    // which would make `network rm` fail with "has active endpoints" — the recreate path must clear
    // both before attempting rm.
    const { docker, calls } = makeDocker({ inspectCode: 0, internal: false });
    await ensureNetwork(new ContainerManager(docker), "ws1", false);
    const disconnect = calls.find((c) => c[0] === "network" && c[1] === "disconnect" && c.includes("-f"));
    expect(disconnect).toBeDefined();
    expect(disconnect).toContain("ws_ws1");
    const rmIdx = calls.findIndex((c) => c[0] === "network" && c[1] === "rm");
    expect(calls.indexOf(disconnect!)).toBeLessThan(rmIdx);
  });

  it("throws when the network can't be removed for recreation", async () => {
    const { docker } = makeDocker({ inspectCode: 0, internal: false });
    const originalCmd = docker.cmd.bind(docker);
    docker.cmd = async (...args: string[]) => {
      if (args[0] === "network" && args[1] === "rm") return { stdout: "", stderr: "boom", code: 1 };
      return originalCmd(...args);
    };
    await expect(ensureNetwork(new ContainerManager(docker), "ws1", false)).rejects.toThrow(/network rm failed/);
  });
});

describe("ContainerManager.stop — network is emptied, not deleted", () => {
  it("disconnects the container but does NOT `network rm` (deleting the bridge blips the tunnel)", async () => {
    const { docker, calls } = makeDocker();
    await new ContainerManager(docker).stop("ws1");
    expect(calls.some((c) => c[0] === "stop" && c[1] === "ws_ws1")).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "disconnect" && c.includes("wsnet_ws1"))).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm")).toBe(false);
  });
});

describe("ContainerManager.sweepManagedNetworks — lazy reclaim", () => {
  afterEach(() => vi.useRealTimers());

  it("removes a managed network that has stayed empty past the grace window", async () => {
    const { docker, rmTargets } = makeSweepDocker({ wsnet_ws1: 0 });
    await new ContainerManager(docker).sweepManagedNetworks(0);
    expect(rmTargets()).toEqual(["wsnet_ws1"]);
  });

  it("skips a network that still has attached endpoints (running/waking workspace)", async () => {
    const { docker, rmTargets } = makeSweepDocker({ wsnet_ws1: 2 });
    await new ContainerManager(docker).sweepManagedNetworks(0);
    expect(rmTargets()).toEqual([]);
  });

  it("holds an empty network through the grace window, reclaiming it only once it elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const { docker, rmTargets } = makeSweepDocker({ wsnet_ws1: 0 });
    const mgr = new ContainerManager(docker);
    await mgr.sweepManagedNetworks(60_000);
    expect(rmTargets()).toEqual([]); // just seen empty — still within grace
    vi.setSystemTime(new Date("2026-09-02T00:02:00Z")); // +2 min > grace
    await mgr.sweepManagedNetworks(60_000);
    expect(rmTargets()).toEqual(["wsnet_ws1"]);
  });

  it("re-checks emptiness under the lock and skips a network that filled up before rm", async () => {
    // First inspect (the ls scan) reports empty; the second (the locked re-check) reports a container
    // that a wake reattached in between. The rm must not fire.
    let inspects = 0;
    const calls: string[][] = [];
    const docker: IDockerClient = {
      cmd: async (...args: string[]): Promise<DockerResult> => {
        calls.push(args);
        if (args[0] === "network" && args[1] === "ls") return { stdout: "wsnet_ws1", stderr: "", code: 0 };
        if (args[0] === "network" && args[1] === "inspect") {
          inspects += 1;
          return { stdout: inspects === 1 ? "0" : "1", stderr: "", code: 0 };
        }
        return OK;
      },
      build: async () => {},
      exec: async () => OK,
    };
    await new ContainerManager(docker).sweepManagedNetworks(0);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm")).toBe(false);
  });
});
