// System packages are the one thing a workspace installs that the durable /home/dev mount cannot
// save: apt writes to /usr, /etc and /var, which nothing mounts, so they die with the container's
// writable layer. Replaying the recipe on the create path is what closes that last gap and makes
// "destroy the container and let it come back" a lossless operation rather than a lossy one.
//
// It is deliberately best-effort. A workspace missing ffmpeg is degraded and the agent can install
// it again; a workspace whose container refuses to start is dead.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { IDockerClient, DockerResult } from "./dockerClient";
import { APT_REPLAY_TIMEOUT_MS } from "../limits";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-apt-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// WORKSPACES_ROOT is read at module load in paths.ts, so the manager needs a fresh module graph
// pointed at this test's temp root — the same trick containerManager.agentHome.test.ts uses.
async function loadManager() {
  vi.resetModules();
  process.env.WORKSPACES_ROOT = root;
  delete process.env.WORKSPACES_VOLUME_NAME;
  return (await import("./containerManager")).ContainerManager;
}

async function writeRecipe(workspaceId: string, packages: string[]) {
  await mkdir(path.join(root, ".homes"), { recursive: true });
  await writeFile(path.join(root, ".homes", `${workspaceId}.apt.json`), JSON.stringify(packages));
  // A seeded home, so ensure() takes the create path without also running the seed.
  await mkdir(path.join(root, ".homes", workspaceId), { recursive: true });
  await writeFile(path.join(root, ".homes", `${workspaceId}.seeded`), "");
}

// `unavailable` models packages the repos no longer carry — an aged-out pin, a rename. apt-get
// commits or aborts the whole transaction, so any install naming one of them fails entirely.
function makeDocker(
  opts: {
    failUpdate?: boolean;
    failInstall?: boolean;
    throwOnExec?: boolean;
    unavailable?: string[];
    // An apt that never answers — a mirror that accepted the connection and then went quiet. Nothing
    // under the replay has a clock of its own, so this hangs forever unless the deadline cuts it.
    hangOn?: "update" | "install";
  } = {},
) {
  const execs: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "", stderr: "no such network", code: 1 };
      return OK;
    },
    exec: async (_name: string, cmdArgs: string[]): Promise<DockerResult> => {
      execs.push(cmdArgs);
      if (opts.hangOn && cmdArgs[1] === opts.hangOn) return new Promise<DockerResult>(() => {});
      if (opts.throwOnExec && cmdArgs[0] === "apt-get") throw new Error("docker daemon went away");
      if (opts.failUpdate && cmdArgs[1] === "update") return { stdout: "", stderr: "network unreachable", code: 1 };
      if (cmdArgs[1] === "install") {
        if (opts.failInstall) return { stdout: "", stderr: "no such package", code: 100 };
        if (opts.unavailable?.some((p) => cmdArgs.includes(p))) {
          return { stdout: "", stderr: "Version not found", code: 100 };
        }
      }
      return OK;
    },
    build: async () => {},
  };
  return { docker, execs };
}

const deps = (internetAccess: boolean) => ({
  internetAccessFor: () => internetAccess,
  runEnvironment: () => ({ envArgs: [], hasProxyCA: false }),
  execEnvironment: () => ({}),
  installProxyCA: async () => {},
});

const aptInstall = (execs: string[][]) => execs.find((c) => c[0] === "apt-get" && c[1] === "install");
const aptInstalls = (execs: string[][]) => execs.filter((c) => c[0] === "apt-get" && c[1] === "install");
const installedPackages = (execs: string[][]) =>
  aptInstalls(execs)
    .slice(1)
    .filter((c) => c.length === 5)
    .map((c) => c[4]);
const aptUpdate = (execs: string[][]) => execs.find((c) => c[0] === "apt-get" && c[1] === "update");
const aptCleanup = (execs: string[][]) => execs.find((c) => c.join(" ").includes("apt-get clean"));

describe("apt recipe — replaying it into a rebuilt container", () => {
  it("reinstalls the recorded packages when the container is created", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg", "htop"]);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptUpdate(execs)).toBeDefined();
    expect(aptInstall(execs)).toEqual(["apt-get", "install", "-y", "--no-install-recommends", "ffmpeg", "htop"]);
  });

  // apt reaches the repos through the credential proxy, and the image's GitHub CLI source is HTTPS,
  // so a replay before the CA is trusted fails on the refresh.
  it("runs after the proxy CA is installed", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker, execs } = makeDocker();
    const order: string[] = [];

    await new ContainerManager(docker, {
      ...deps(true),
      installProxyCA: async () => {
        order.push("ca");
      },
    }).ensure("ws1", "/w");
    if (aptUpdate(execs)) order.push("apt");

    expect(order).toEqual(["ca", "apt"]);
  });

  it("touches apt at all only when there is something to reinstall", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", []);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptUpdate(execs)).toBeUndefined();
    expect(aptInstall(execs)).toBeUndefined();
  });

  // An internet-less workspace is on an --internal network with no route to the repos at all, so
  // this is an expected skip rather than a failure to report.
  it("skips the replay for a workspace with no internet access", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(false)).ensure("ws1", "/w");

    expect(aptUpdate(execs)).toBeUndefined();
    expect(aptInstall(execs)).toBeUndefined();
  });

  it("does not attempt the install when the index refresh fails", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker, execs } = makeDocker({ failUpdate: true });

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptInstall(execs)).toBeUndefined();
  });
});

// apt-get commits or aborts the whole transaction. Left as a single call, one package the repos no
// longer carry — which happens on its own, at the next point release, with nobody doing anything
// wrong — would take the other nine down with it and hand back a bare container. That is the exact
// failure this branch exists to prevent, arriving through the recovery path itself.
describe("apt recipe — one unavailable package does not cost the workspace the rest", () => {
  it("installs everything else when one package can no longer be installed", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg=7:6.1.1-3ubuntu5", "htop", "tmux", "rsync"]);
    const { docker, execs } = makeDocker({ unavailable: ["ffmpeg=7:6.1.1-3ubuntu5"] });

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(installedPackages(execs)).toEqual(["ffmpeg=7:6.1.1-3ubuntu5", "htop", "tmux", "rsync"]);
    // The bulk attempt plus one retry per package — nothing skipped after the first failure.
    expect(aptInstalls(execs)).toHaveLength(5);
  });

  it("keeps the single bulk install when nothing is wrong", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg", "htop", "tmux"]);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    // The retry loop is the salvage path, not the normal one: three packages must cost one call.
    expect(aptInstalls(execs)).toHaveLength(1);
  });

  it("does not retry individually when the index refresh is what failed", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg", "htop"]);
    const { docker, execs } = makeDocker({ failUpdate: true });

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptInstalls(execs)).toHaveLength(0);
  });
});

describe("apt recipe — a failed replay never costs the workspace its container", () => {
  it("still creates a usable container when the install fails", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["nosuchpkg"]);
    const { docker } = makeDocker({ failInstall: true });

    await expect(new ContainerManager(docker, deps(true)).ensure("ws1", "/w")).resolves.toBeUndefined();
  });

  it("still creates a usable container when the index refresh fails", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker } = makeDocker({ failUpdate: true });

    await expect(new ContainerManager(docker, deps(true)).ensure("ws1", "/w")).resolves.toBeUndefined();
  });

  it("still creates a usable container when the exec itself throws", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker } = makeDocker({ throwOnExec: true });

    await expect(new ContainerManager(docker, deps(true)).ensure("ws1", "/w")).resolves.toBeUndefined();
  });
});

// A stall is not a failure: apt never answers, so the code below it never returns. Nothing in the
// replay has a clock — `docker exec` has no timeout — so the deadline is the only thing that ends it.
describe("apt recipe — a stalled replay never costs the workspace its container", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The create path is real I/O — the seed, the image hash — so the deadline does not exist yet when
   * ensure() is called, and advancing the clock straight away would fire nothing. setImmediate is
   * left real so each turn lets that I/O land; only then has the replay armed its timer.
   */
  async function reachTheStall(execs: string[][], hangOn: string) {
    for (let turn = 0; turn < 1_000; turn++) {
      if (execs.some((c) => c[0] === "apt-get" && c[1] === hangOn)) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`replay never reached apt-get ${hangOn}`);
  }

  async function ensureWithStall(hangOn: "update" | "install") {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg", "htop"]);
    const { docker, execs } = makeDocker({ hangOn });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ensured = new ContainerManager(docker, deps(true)).ensure("ws1", "/w");
    await reachTheStall(execs, hangOn);
    await vi.advanceTimersByTimeAsync(APT_REPLAY_TIMEOUT_MS);
    return { ensured, execs };
  }

  it("hands the container over when the install never answers", async () => {
    const { ensured } = await ensureWithStall("install");
    await expect(ensured).resolves.toBeUndefined();
  });

  it("hands the container over when the index refresh never answers", async () => {
    const { ensured } = await ensureWithStall("update");
    await expect(ensured).resolves.toBeUndefined();
  });

  // Abandoning the exec does not stop apt inside the container. Wiping the index out from under a
  // still-running install would sabotage the packages a slow-but-working replay is about to land.
  it("leaves the abandoned apt's downloads alone", async () => {
    const { ensured, execs } = await ensureWithStall("install");
    await ensured;

    expect(aptCleanup(execs)).toBeUndefined();
  });

  // A 5-minute handle left behind by every container create would pin the event loop for no reason.
  it("disarms the deadline once the replay is done", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("empty", []);
    await writeRecipe("replayed", ["ffmpeg"]);
    const { docker } = makeDocker();
    const manager = new ContainerManager(docker, deps(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await manager.ensure("empty", "/w");
    const perWorkspace = vi.getTimerCount();
    await manager.ensure("replayed", "/w");

    // Measured against a workspace with nothing to replay, so the idle timer ensure() always arms
    // is counted rather than assumed: a finished replay must leave nothing of its own on top.
    expect(vi.getTimerCount()).toBe(perWorkspace * 2);
  });
});

describe("apt recipe — the replay cleans up after itself", () => {
  // The container is kept for the life of the workspace, so the .debs and the repository index the
  // replay downloads would otherwise sit there for good. Same reasoning as the apt_install tool.
  it("discards what it downloaded", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptCleanup(execs)).toBeDefined();
  });

  it("discards what it downloaded even when the install failed", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["nosuchpkg"]);
    const { docker, execs } = makeDocker({ failInstall: true });

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptCleanup(execs)).toBeDefined();
  });

  // Package names must never reach a shell. The cleanup is the one shelled command in the replay.
  it("never puts a package name through the shell", async () => {
    const ContainerManager = await loadManager();
    await writeRecipe("ws1", ["ffmpeg"]);
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    const shelled = execs.filter((c) => c[0] === "/bin/sh");
    expect(shelled).toHaveLength(1);
    expect(shelled[0].join(" ")).not.toContain("ffmpeg");
  });
});
