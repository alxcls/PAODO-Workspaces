// The workspace container is stateful and must never be destroyed automatically.
//
// Its writable layer holds everything the agent has installed since creation — apt packages, pip
// and npm modules, nvm/pyenv runtimes — which is the workspace's real content. The image is only
// where it started. A container that has drifted from its image is working as intended, so nothing
// short of an explicit workspace deletion may `docker rm` it.
//
// This regressed once already: an internet-access toggle changed a credential fingerprint, the
// fingerprint mismatch triggered a rebuild, and a workspace silently lost its installed packages
// mid-session. These tests pin the invariants that prevent that, all of which are about what
// commands are NOT issued.
import { describe, it, expect } from "vitest";
import type { IDockerClient, DockerResult } from "./dockerClient";
import type { ContainerWorkspaceDependencies } from "./containerManager";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const SIDECAR = "paodo_ws_credproxy";

// Prod shape (sidecar present) — captured in module-level consts, so set before the dynamic import.
process.env.WORKSPACES_VOLUME_NAME = "paodo_ws_workspaces";
const { ContainerManager } = await import("./containerManager");

const SECRET_ENV = { API_TOKEN: "p-opaque-token" };

const workspaceDeps: ContainerWorkspaceDependencies = {
  internetAccessFor: () => true,
  runEnvironment: () => ({ envArgs: ["-e", "HTTP_PROXY=http://proxy"], hasProxyCA: false }),
  execEnvironment: () => SECRET_ENV,
  installProxyCA: async () => {},
};

/**
 * Docker mock reporting an EXISTING container whose image label deliberately disagrees with the
 * current Dockerfile hash — the exact condition that used to trigger a rebuild.
 */
function makeDocker(status: "running" | "stopped") {
  const calls: string[][] = [];
  const execCalls: { args: string[]; opts?: Record<string, unknown> }[] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") {
        // Container status probe, and the image-hash label — stale on purpose.
        if (args.includes("{{.State.Status}}")) return { stdout: status, stderr: "", code: 0 };
        return { stdout: "hash-from-a-much-older-image", stderr: "", code: 0 };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        if (args.includes("{{range .Containers}}{{.Name}} {{end}}")) {
          return { stdout: `${SIDECAR} `, stderr: "", code: 0 };
        }
        return { stdout: "false", stderr: "", code: 0 }; // exists, not --internal → matches "on"
      }
      return OK;
    },
    build: async () => {},
    exec: async (_name, args, opts) => {
      execCalls.push({ args, opts: opts as Record<string, unknown> });
      return OK;
    },
  };
  return { docker, calls, execCalls };
}

const issued = (calls: string[][], verb: string) => calls.filter((c) => c[0] === verb);
const networkVerbs = (calls: string[][]) => calls.filter((c) => c[0] === "network").map((c) => c[1]);

/**
 * Docker mock that actually MODELS the workspace network, so a rebuild can be observed failing and
 * the next wake can be observed repairing it. The container is always running and is never modelled
 * as removable — losing it is the one outcome these tests exist to rule out.
 */
function makeNetworkDocker(opts: { internal: boolean; failNextCreate?: boolean }) {
  let net: { internal: boolean } | null = { internal: opts.internal };
  let failCreate = opts.failNextCreate ?? false;
  const calls: string[][] = [];
  const missing: DockerResult = { stdout: "", stderr: "no such network", code: 1 };

  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") {
        return args.includes("{{.State.Status}}") ? { stdout: "running", stderr: "", code: 0 } : OK;
      }
      if (args[0] !== "network") return OK;
      switch (args[1]) {
        case "inspect":
          if (!net) return missing;
          // The sidecar is reported present on any network that exists, so proxy.verify() passes
          // and these tests stay about the container's own membership.
          return args.includes("{{range .Containers}}{{.Name}} {{end}}")
            ? { stdout: `${SIDECAR} `, stderr: "", code: 0 }
            : { stdout: String(net.internal), stderr: "", code: 0 };
        case "rm":
          net = null;
          return OK;
        case "create":
          if (failCreate) {
            failCreate = false;
            return { stdout: "", stderr: "no available IPv4 addresses", code: 1 };
          }
          net = { internal: args.includes("--internal") };
          return OK;
        default:
          return OK; // connect / disconnect
      }
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls, network: () => net };
}

/**
 * The container outlives every network operation performed around it, so it can be left behind by
 * one. These pin that the next wake repairs the network rather than the container.
 */
describe("a wake reconciles the network the container is on", () => {
  it("rejoins a container stranded by a network rebuild that failed partway", async () => {
    const { docker, calls, network } = makeNetworkDocker({ internal: false, failNextCreate: true });
    const mgr = new ContainerManager(docker, workspaceDeps);

    // Turning access off removes the old network, then fails to create the replacement — leaving a
    // running container attached to nothing at all.
    await expect(mgr.applyInternetAccess("ws1", false)).rejects.toThrow("docker network create failed");
    expect(network()).toBeNull();

    const afterToggle = calls.length;
    await mgr.ensure("ws1", "/w");

    // The very next command puts the network back and rejoins it — no marker, no waiting for the
    // idle timer, and above all no new container.
    const repair = calls.slice(afterToggle);
    expect(networkVerbs(repair)).toContain("create");
    expect(networkVerbs(repair)).toContain("connect");
    expect(network()).not.toBeNull();
    expect(issued(repair, "stop")).toHaveLength(0);
    expect(issued(repair, "rm")).toHaveLength(0);
    expect(issued(repair, "run")).toHaveLength(0);
  });

  it("rebuilds a network whose egress flag disagrees with the workspace's setting", async () => {
    // Network is --internal; workspaceDeps says this workspace has internet access. A rolled-back
    // toggle leaves exactly this disagreement, and only a stop/start used to resolve it.
    const { docker, calls } = makeNetworkDocker({ internal: true });
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).not.toContain("--internal");
    expect(networkVerbs(calls)).toContain("connect");
    expect(issued(calls, "stop")).toHaveLength(0);
    expect(issued(calls, "rm")).toHaveLength(0);
    expect(issued(calls, "run")).toHaveLength(0);
  });

  it("leaves a healthy network alone", async () => {
    const { docker, calls } = makeNetworkDocker({ internal: false });
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    // Reconciling costs an inspect and an idempotent connect — it must never churn the network of a
    // workspace that is already correct.
    expect(networkVerbs(calls)).not.toContain("rm");
    expect(networkVerbs(calls)).not.toContain("create");
  });
});

describe("workspace container is never destroyed automatically", () => {
  it("reuses a RUNNING container even when its image is out of date", async () => {
    const { docker, calls } = makeDocker("running");
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    expect(issued(calls, "rm")).toHaveLength(0);
    expect(issued(calls, "run")).toHaveLength(0);
    expect(issued(calls, "stop")).toHaveLength(0);
  });

  it("restarts a STOPPED container in place rather than rebuilding it", async () => {
    const { docker, calls } = makeDocker("stopped");
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    // `docker start` preserves the writable layer; `docker rm` + `run` would not.
    expect(issued(calls, "start")).toHaveLength(1);
    expect(issued(calls, "rm")).toHaveLength(0);
    expect(issued(calls, "run")).toHaveLength(0);
  });

  it("does not even consult the container's image hash — drift is not a reason to act", async () => {
    const { docker, calls } = makeDocker("running");
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    const inspectedLabels = calls.filter(
      (c) => c[0] === "inspect" && c.some((a) => a.includes("paodo.workspace-hash")),
    );
    expect(inspectedLabels).toHaveLength(0);
  });
});

describe("secrets reach the container per command, not at creation", () => {
  // ensure() runs first and issues its own execs (the background-task rehydration scan), so the
  // command under test is the last one, not the first.
  it("passes secret env to docker exec", async () => {
    const { docker, execCalls } = makeDocker("running");
    const mgr = new ContainerManager(docker, workspaceDeps);
    await mgr.exec("ws1", "/w", ["printenv"]);

    const call = execCalls.at(-1)!;
    expect(call.args).toEqual(["printenv"]);
    expect(call.opts?.env).toEqual(SECRET_ENV);
  });

  // apt reaches the credential proxy through the CONTAINER's env (buildRunEnv), which every exec
  // inherits — so the per-command secret env, which carries nothing but the workspace's tokens,
  // would be pure over-grant on the one exec that runs as root.
  it("withholds secret env from the root exec path", async () => {
    const { docker, execCalls } = makeDocker("running");
    const mgr = new ContainerManager(docker, workspaceDeps);
    await mgr.execAsRoot("ws1", "/w", ["apt-get", "install", "-y", "ffmpeg"]);

    const call = execCalls.at(-1)!;
    expect(call.args).toContain("apt-get");
    expect(call.opts?.env).toBeUndefined();
    expect(call.opts?.asRoot).toBe(true);
  });

  it("keeps secrets out of docker run, so a long-lived container never freezes a stale set", async () => {
    // No container yet — this is the one path that actually creates one.
    const calls: string[][] = [];
    const docker: IDockerClient = {
      cmd: async (...args: string[]): Promise<DockerResult> => {
        calls.push(args);
        if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
        if (args[0] === "network" && args[1] === "inspect") {
          if (args.includes("{{range .Containers}}{{.Name}} {{end}}")) {
            return { stdout: `${SIDECAR} `, stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "no such network", code: 1 };
        }
        return OK;
      },
      build: async () => {},
      exec: async () => OK,
    };
    await new ContainerManager(docker, workspaceDeps).ensure("ws1", "/w");

    const runArgs = calls.find((c) => c[0] === "run")!;
    expect(runArgs.join(" ")).not.toContain("API_TOKEN");
    expect(runArgs.join(" ")).not.toContain("p-opaque-token");
    // The static proxy wiring does still belong at create time.
    expect(runArgs).toContain("HTTP_PROXY=http://proxy");
  });
});

describe("applyInternetAccess rebuilds the network around a live container", () => {
  it("swaps the network without stopping, removing or recreating the container", async () => {
    const { docker, calls } = makeDocker("running");
    await new ContainerManager(docker, workspaceDeps).applyInternetAccess("ws1", false);

    // The container is untouched — this is the whole point.
    expect(issued(calls, "stop")).toHaveLength(0);
    expect(issued(calls, "rm")).toHaveLength(0);
    expect(issued(calls, "run")).toHaveLength(0);

    // The network is rebuilt with the new policy and the container rejoined.
    const netCalls = calls.filter((c) => c[0] === "network").map((c) => c.slice(0, 2).join(" "));
    expect(netCalls).toContain("network rm");
    expect(netCalls).toContain("network create");
    expect(netCalls).toContain("network connect");

    const create = calls.find((c) => c[0] === "network" && c[1] === "create")!;
    expect(create).toContain("--internal");
  });

  it("creates a routable network when switching access back on", async () => {
    const { docker, calls } = makeDocker("running");
    // Seed reports a non-internal network, so turning access ON is already consistent and the
    // network is left alone — but the container must never be disturbed either way.
    await new ContainerManager(docker, workspaceDeps).applyInternetAccess("ws1", true);

    expect(issued(calls, "stop")).toHaveLength(0);
    expect(issued(calls, "rm")).toHaveLength(0);
    expect(issued(calls, "run")).toHaveLength(0);
  });

  it("does nothing when the workspace has never been started", async () => {
    const calls: string[][] = [];
    const docker: IDockerClient = {
      cmd: async (...args: string[]): Promise<DockerResult> => {
        calls.push(args);
        return { stdout: "", stderr: "no such object", code: 1 };
      },
      build: async () => {},
      exec: async () => OK,
    };
    await new ContainerManager(docker, workspaceDeps).applyInternetAccess("ws1", false);

    // Only the status probe. The network is built with the right flag at first create.
    expect(calls.filter((c) => c[0] === "network")).toHaveLength(0);
  });
});
