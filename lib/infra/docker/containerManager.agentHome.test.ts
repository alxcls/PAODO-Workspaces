// The agent's home must outlive its container.
//
// Everything the agent installs that is NOT an apt package lands under /home/dev — npm globals, pip
// packages, extra node/python versions, and anything a downloaded installer places (rustup, go and
// friends hardcode $HOME and cannot be redirected). Left in the container's writable layer, all of
// it dies with a `docker rm`, which is why containers were never recreated and why a /workspace-only
// backup silently restores a workspace with the user's files and none of their tools.
//
// Mounting it durably is what makes that whole class of loss impossible, so these tests pin the two
// halves that have to hold together: the mount is always there, and it is filled from the image
// exactly once — a container started on an empty home reads as "node is missing", not "setup broke".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const VOLUME = "paodo_ws_workspaces";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// WORKSPACES_ROOT and WORKSPACES_VOLUME_NAME are read once at module load, so the per-test temp root
// needs a fresh module graph — the same dynamic-import trick containerManager.persistence.test.ts uses.
async function loadManager(volume: string) {
  vi.resetModules();
  process.env.WORKSPACES_ROOT = root;
  process.env.WORKSPACES_VOLUME_NAME = volume;
  return (await import("./containerManager")).ContainerManager;
}

// Nothing exists yet, so ensure() takes the full create path: seed first, then the container.
function makeDocker(opts: { failSeed?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "", stderr: "no such network", code: 1 };
      if (opts.failSeed && args[0] === "run" && !args.includes("--name")) {
        return { stdout: "", stderr: "no space left on device", code: 1 };
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

const seedRun = (calls: string[][]) => calls.find((c) => c[0] === "run" && !c.includes("--name"));
const containerRun = (calls: string[][]) => calls.find((c) => c[0] === "run" && c.includes("--name"));

describe("agent home — the durable mount", () => {
  it("mounts both the workspace and the agent home when creating a container", async () => {
    const ContainerManager = await loadManager(VOLUME);
    const { docker, calls } = makeDocker();
    await new ContainerManager(docker).ensure("ws1", "/w");

    const args = containerRun(calls)!.join(" ");
    expect(args).toContain(`type=volume,source=${VOLUME},target=/workspace,volume-subpath=w`);
    expect(args).toContain(`type=volume,source=${VOLUME},target=/home/dev,volume-subpath=.homes/ws1`);
  });
});

describe("agent home — filling it from the image", () => {
  it("copies the image's home in before the container starts, preserving ownership", async () => {
    const ContainerManager = await loadManager(VOLUME);
    const { docker, calls } = makeDocker();
    await new ContainerManager(docker).ensure("ws1", "/w");

    const seed = seedRun(calls)!;
    // Root, because the tree it reads is not the app's; -a so uid 1000 survives the copy and the
    // agent can still write its own home afterwards.
    expect(seed).toEqual(expect.arrayContaining(["-u", "0", "cp", "-a", "/home/dev/.", "/seed/"]));
    expect(seed.join(" ")).toContain("--network none");
    expect(seed).toContain(`type=volume,source=${VOLUME},target=/seed,volume-subpath=.homes/ws1`);
    expect(calls.indexOf(seed)).toBeLessThan(calls.indexOf(containerRun(calls)!));
  });

  it("never re-seeds a home that already holds the agent's own installs", async () => {
    const ContainerManager = await loadManager(VOLUME);
    await mkdir(path.join(root, ".homes", "ws1", ".nvm"), { recursive: true });
    await writeFile(path.join(root, ".homes", "ws1", ".bashrc"), "installed by the agent");
    await writeFile(path.join(root, ".homes", "ws1.seeded"), "");

    const { docker, calls } = makeDocker();
    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(seedRun(calls)).toBeUndefined();
    expect(containerRun(calls)).toBeDefined();
  });

  it("refuses to create the container at all when the seed fails", async () => {
    const ContainerManager = await loadManager(VOLUME);
    const { docker, calls } = makeDocker({ failSeed: true });

    await expect(new ContainerManager(docker).ensure("ws1", "/w")).rejects.toThrow(/agent home seed failed/);
    // The whole point: a container on an empty home would come up with no node and no python.
    expect(containerRun(calls)).toBeUndefined();
    // No receipt, so the retry below still knows the home is unfinished.
    await expect(access(path.join(root, ".homes", "ws1.seeded"))).rejects.toThrow();
  });

  // The failure above leaves a half-copied tree behind. Judging "already seeded" by whether the
  // directory has anything in it would skip the retry and boot a workspace missing half its tooling.
  it("re-seeds after a copy that died partway, rather than trusting the files it left", async () => {
    const ContainerManager = await loadManager(VOLUME);
    const { docker: failing } = makeDocker({ failSeed: true });
    await expect(new ContainerManager(failing).ensure("ws1", "/w")).rejects.toThrow(/agent home seed failed/);
    await mkdir(path.join(root, ".homes", "ws1", ".nvm"), { recursive: true });

    const { docker, calls } = makeDocker();
    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(seedRun(calls)).toBeDefined();
    expect(containerRun(calls)).toBeDefined();
    await expect(access(path.join(root, ".homes", "ws1.seeded"))).resolves.toBeUndefined();
  });
});
