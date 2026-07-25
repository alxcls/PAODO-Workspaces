// ensureNetwork is the network-layer half of the internet-access toggle: it must create the
// workspace's network with --internal when access is off, and — since Docker can't flip --internal
// on an existing network — detect and repair a stale network whose flag doesn't match the current
// policy. Reached directly (private method) so these tests don't have to drive the full
// _ensureContainer state machine (image hash, secrets, container run) just to exercise this logic.
import { describe, it, expect } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

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
  return (
    mgr as unknown as { ensureNetwork(id: string, internetAccess: boolean): Promise<void> }
  ).ensureNetwork(workspaceId, internetAccess);
}

describe("ContainerManager.ensureNetwork — creation", () => {
  it("creates a plain bridge network when internet access is on", async () => {
    const { docker, calls } = makeDocker({ inspectCode: 1 });
    await ensureNetwork(new ContainerManager(docker), "ws1", true);
    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).toBeDefined();
    expect(create).not.toContain("--internal");
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
