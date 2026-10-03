// The relay dies with its container and nothing inside restarts it, so every start must start it
// again, while commands in between must not pay for a check each.
import { describe, it, expect, vi } from "vitest";
import type { IDockerClient, DockerResult } from "./dockerClient";
import type { ContainerWorkspaceDependencies } from "./containerManager";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

process.env.WORKSPACES_VOLUME_NAME = "paodo_ws_workspaces";
const { ContainerManager } = await import("./containerManager");

function makeDocker(initial: "running" | "stopped") {
  let status = initial;
  let sidecarAttached = false;
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      if (args[0] === "inspect") return { stdout: status, stderr: "", code: 0 };
      if (args[0] === "start") status = "running";
      if (args[0] === "stop") status = "stopped";
      if (args[0] !== "network") return OK;
      const sidecar = args.includes("paodo_ws_credproxy");
      if (args[1] === "connect" && sidecar) sidecarAttached = true;
      if (args[1] === "disconnect" && sidecar) sidecarAttached = false;
      if (args[1] === "inspect") {
        const sidecarProbe = args.includes("{{range .Containers}}{{.Name}} {{end}}");
        if (!sidecarProbe) return { stdout: "true", stderr: "", code: 0 };
        return { stdout: sidecarAttached ? "paodo_ws_credproxy " : "", stderr: "", code: 0 };
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return docker;
}

function makeDeps(opts: { relayUp?: boolean; internetAccess?: boolean } = {}) {
  const ensureProxyRelay = vi.fn(async () => opts.relayUp ?? true);
  const execEnvironment = vi.fn((_ws: string, _internet: boolean, _relayReady: boolean) => ({}));
  const deps: ContainerWorkspaceDependencies = {
    internetAccessFor: () => opts.internetAccess ?? true,
    runEnvironment: () => ({ envArgs: [], hasProxyCA: true }),
    execEnvironment,
    installProxyCA: async () => {},
    ensureProxyRelay,
  };
  return { deps, ensureProxyRelay, execEnvironment };
}

const relayReadyOfLastCommand = (execEnvironment: ReturnType<typeof makeDeps>["execEnvironment"]) =>
  execEnvironment.mock.calls.at(-1)?.[2];

describe("egress relay lifecycle", () => {
  it("starts the relay on a running container first seen by this app, then not again per command", async () => {
    const { deps, ensureProxyRelay, execEnvironment } = makeDeps();
    const mgr = new ContainerManager(makeDocker("running"), deps);

    await mgr.exec("ws1", "/w", ["true"]);
    await mgr.exec("ws1", "/w", ["true"]);

    expect(ensureProxyRelay).toHaveBeenCalledTimes(1);
    expect(relayReadyOfLastCommand(execEnvironment)).toBe(true);
  });

  it("starts it again after the container stops and wakes", async () => {
    const { deps, ensureProxyRelay } = makeDeps();
    const mgr = new ContainerManager(makeDocker("stopped"), deps);

    await mgr.exec("ws1", "/w", ["true"]);
    await mgr.stop("ws1");
    await mgr.exec("ws1", "/w", ["true"]);

    expect(ensureProxyRelay).toHaveBeenCalledTimes(2);
  });

  it("keeps the container's own proxy settings when the relay is not up", async () => {
    const { deps, execEnvironment } = makeDeps({ relayUp: false });
    const mgr = new ContainerManager(makeDocker("stopped"), deps);

    await mgr.exec("ws1", "/w", ["true"]);

    expect(relayReadyOfLastCommand(execEnvironment)).toBe(false);
  });

  it("allows installing the relay only when the workspace has internet access", async () => {
    for (const internetAccess of [true, false]) {
      const { deps, ensureProxyRelay } = makeDeps({ internetAccess });
      await new ContainerManager(makeDocker("stopped"), deps).exec("ws1", "/w", ["true"]);
      expect(ensureProxyRelay).toHaveBeenCalledWith(expect.anything(), "ws_ws1", "ws1", internetAccess);
    }
  });
});
