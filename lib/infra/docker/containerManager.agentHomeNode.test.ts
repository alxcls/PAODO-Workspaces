// Homes seeded by an older image receive the current image's Node on their next wake, without the
// container ever being recreated — the persistence invariants still hold.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { IDockerClient, DockerResult } from "./dockerClient";
import { imageNodeVersion } from "../agentHomeNode";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const VOLUME = "paodo_ws_workspaces";
const TARGET = (await imageNodeVersion(path.resolve("Dockerfile.workspace")))!;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-home-node-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function loadManager() {
  vi.resetModules();
  process.env.WORKSPACES_ROOT = root;
  process.env.WORKSPACES_VOLUME_NAME = VOLUME;
  return (await import("./containerManager")).ContainerManager;
}

const home = (id: string) => path.join(root, ".homes", id);
const alias = (id: string) => readFile(path.join(home(id), ".nvm", "alias", "default"), "utf-8");

// A home seeded by the Node 22 image, exactly as the durable mount holds it today.
async function legacyHome(id: string) {
  const nvm = path.join(home(id), ".nvm");
  await mkdir(path.join(nvm, "versions", "node", "v22.23.2", "bin"), { recursive: true });
  await mkdir(path.join(nvm, "versions", "node", "v22.23.2", "lib", "node_modules", "npm"), { recursive: true });
  await mkdir(path.join(nvm, "alias"), { recursive: true });
  await writeFile(path.join(nvm, "nvm.sh"), "");
  await writeFile(path.join(nvm, "versions", "node", "v22.23.2", "bin", "node"), "");
  await writeFile(path.join(nvm, "alias", "default"), "22.23.2\n");
  await writeFile(`${home(id)}.seeded`, "");
}

// A running container; the copy run is modelled by writing what `cp -a` would have produced.
function makeDocker(opts: { status?: "running" | "missing"; failCopy?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") {
        if (opts.status === "missing") return { stdout: "", stderr: "no such object", code: 1 };
        return { stdout: "running", stderr: "", code: 0 };
      }
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "true", stderr: "", code: 0 };
      if (args[0] === "run" && args.includes("cp") && args.at(-1)!.includes(".tmp")) {
        if (opts.failCopy) return { stdout: "", stderr: "no space left on device", code: 1 };
        const id = args.find((a) => a.includes("volume-subpath=.homes/"))!.split(".homes/")[1];
        const staged = path.join(home(id), ".nvm", "versions", "node", `.v${TARGET}.tmp`, "bin");
        await mkdir(staged, { recursive: true });
        await writeFile(path.join(staged, "node"), "");
      }
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

const copyRuns = (calls: string[][]) => calls.filter((c) => c[0] === "run" && c.at(-1)!.endsWith(".tmp"));

describe("agent home Node upgrade", () => {
  it("delivers the image's Node into a legacy home and moves its default", async () => {
    const ContainerManager = await loadManager();
    await legacyHome("ws1");
    const { docker, calls } = makeDocker();

    await new ContainerManager(docker).ensure("ws1", "/w");

    const [copy] = copyRuns(calls);
    expect(copy).toEqual(expect.arrayContaining(["-u", "0", "cp", "-a", `/home/dev/.nvm/versions/node/v${TARGET}`]));
    expect(copy.join(" ")).toContain("--network none");
    expect(copy).toContain(`type=volume,source=${VOLUME},target=/seed,volume-subpath=.homes/ws1`);
    await expect(
      access(path.join(home("ws1"), ".nvm", "versions", "node", `v${TARGET}`, "bin", "node")),
    ).resolves.toBeUndefined();
    await expect(access(path.join(home("ws1"), ".nvm", "versions", "node", "v22.23.2"))).resolves.toBeUndefined();
    expect(await alias("ws1")).toBe(`${TARGET}\n`);
    expect(await readFile(`${home("ws1")}.node`, "utf-8")).toBe(`${TARGET}\n`);
  });

  it("never removes or recreates the running container to do it", async () => {
    const ContainerManager = await loadManager();
    await legacyHome("ws1");
    const { docker, calls } = makeDocker();

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(calls.filter((c) => c[0] === "rm" || c[0] === "stop")).toEqual([]);
    expect(calls.filter((c) => c[0] === "run" && c.includes("--name"))).toEqual([]);
  });

  it("runs once: later wakes and later processes see the marker", async () => {
    const ContainerManager = await loadManager();
    await legacyHome("ws1");
    const first = makeDocker();
    const manager = new ContainerManager(first.docker);
    await manager.ensure("ws1", "/w");
    await manager.ensure("ws1", "/w");
    expect(copyRuns(first.calls)).toHaveLength(1);

    const second = makeDocker();
    await new ContainerManager(second.docker).ensure("ws1", "/w");
    expect(copyRuns(second.calls)).toEqual([]);
  });

  it("keeps the workspace usable on its old Node when the copy fails, and retries later", async () => {
    const ContainerManager = await loadManager();
    await legacyHome("ws1");
    const failing = makeDocker({ failCopy: true });
    const manager = new ContainerManager(failing.docker);

    await expect(manager.ensure("ws1", "/w")).resolves.toBeUndefined();
    expect(await alias("ws1")).toBe("22.23.2\n");
    await expect(access(`${home("ws1")}.node`)).rejects.toThrow();

    await manager.ensure("ws1", "/w");
    expect(copyRuns(failing.calls)).toHaveLength(2);
  });

  it("records the image's Node at seed time, so a new workspace never runs the upgrade", async () => {
    const ContainerManager = await loadManager();
    const { docker, calls } = makeDocker({ status: "missing" });

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(await readFile(`${home("ws1")}.node`, "utf-8")).toBe(`${TARGET}\n`);
    expect(copyRuns(calls)).toEqual([]);
  });

  it("sweeps every seeded home at boot and shares the work with a concurrent wake", async () => {
    const ContainerManager = await loadManager();
    await legacyHome("ws1");
    await mkdir(home("ws2"), { recursive: true });
    const { docker, calls } = makeDocker();
    const manager = new ContainerManager(docker);

    await Promise.all([manager.migrateAgentHomes(["ws1", "ws2"]), manager.ensure("ws1", "/w")]);

    expect(copyRuns(calls)).toHaveLength(1);
    expect(await alias("ws1")).toBe(`${TARGET}\n`);
    await expect(access(`${home("ws2")}.node`)).rejects.toThrow();
  });
});
