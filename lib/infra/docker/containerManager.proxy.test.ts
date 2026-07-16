// Egress invariant: after ensure(), the credproxy sidecar must be attached to the workspace network
// (otherwise the workspace can't resolve `credproxy` and all agent egress black-holes). These tests
// drive the ensure() wrapper with a stubbed _ensureContainer so they exercise verifyProxyAttached in
// isolation — covering the healthy, self-heal, and loud-failure paths regardless of how the container
// was brought up (create / resume-stopped / reattach-running).
import { describe, it, expect } from "vitest";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const SIDECAR = "paodo_ws_credproxy";

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
