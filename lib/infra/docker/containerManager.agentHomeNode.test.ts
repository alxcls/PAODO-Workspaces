// Homes seeded by an older image receive the current image's Node on their next wake — only ever
// through confined containers, never by the app writing into a home the agent controls.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { IDockerClient, DockerResult } from "./dockerClient";
import { APPLY_NODE_SCRIPT, INSPECT_HOME_SCRIPT, imageNodeVersion } from "../agentHomeNode";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const VOLUME = "paodo_ws_workspaces";
const TARGET = (await imageNodeVersion(path.resolve("Dockerfile.workspace")))!;
const LEGACY_HOME = "nvm\nalias 22.23.2\nversion 22.23.2\nglobal 22.23.2 npm\nglobal 22.23.2 corepack";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-home-node-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function loadManager() {
  vi.resetModules();
  process.env.WORKSPACES_ROOT = root;
  process.env.WORKSPACES_VOLUME_NAME = VOLUME;
  return (await import("./containerManager")).ContainerManager;
}

const home = (id: string) => path.join(root, ".homes", id);

async function seededHome(id: string) {
  await mkdir(home(id), { recursive: true });
  await writeFile(`${home(id)}.seeded`, "");
}

interface DockerOpts {
  status?: "running" | "missing";
  inspectStdout?: string;
  failInspect?: boolean;
  failApply?: boolean;
}

function makeDocker(opts: DockerOpts = {}) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") {
        if (opts.status === "missing") return { stdout: "", stderr: "no such object", code: 1 };
        return { stdout: "running", stderr: "", code: 0 };
      }
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "true", stderr: "", code: 0 };
      if (args.includes(INSPECT_HOME_SCRIPT)) {
        if (opts.failInspect) return { stdout: "", stderr: "boom", code: 1 };
        return { stdout: opts.inspectStdout ?? LEGACY_HOME, stderr: "", code: 0 };
      }
      if (args.includes(APPLY_NODE_SCRIPT) && opts.failApply) return { stdout: "", stderr: "no space left", code: 1 };
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

const inspectRuns = (calls: string[][]) => calls.filter((c) => c.includes(INSPECT_HOME_SCRIPT));
const applyRuns = (calls: string[][]) => calls.filter((c) => c.includes(APPLY_NODE_SCRIPT));
const applyFlags = (call: string[]) => call.slice(call.indexOf(APPLY_NODE_SCRIPT) + 2);

// Every entry under `dir`, symlinks recorded as links (never followed), so any write shows up.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const st = await lstat(p);
    if (st.isSymbolicLink()) out[p] = `-> ${await readlink(p)}`;
    else if (st.isDirectory()) Object.assign(out, { [p]: "dir" }, await snapshot(p));
    else out[p] = await readFile(p, "utf-8");
  }
  return out;
}

describe("agent home Node upgrade", () => {
  it("inspects then delivers through confined containers, and records the marker", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const { docker, calls } = makeDocker();

    await new ContainerManager(docker).ensure("ws1", "/w");

    const [inspect] = inspectRuns(calls);
    const [apply] = applyRuns(calls);
    for (const run of [inspect, apply]) {
      expect(run.slice(0, 2)).toEqual(["run", "--rm"]);
      expect(run).toEqual(expect.arrayContaining(["-u", "1000:1000", "--read-only", "--cap-drop", "ALL"]));
      expect(run.join(" ")).toContain("--network none");
      expect(run.join(" ")).toContain("--security-opt no-new-privileges:true");
    }
    expect(inspect).toContain(`type=volume,source=${VOLUME},target=/seed,volume-subpath=.homes/ws1,readonly`);
    expect(apply).toContain(`type=volume,source=${VOLUME},target=/seed,volume-subpath=.homes/ws1`);
    expect(applyFlags(apply)).toEqual([TARGET, "1", "1"]);
    expect(await readFile(`${home("ws1")}.node`, "utf-8")).toBe(`${TARGET}\n`);
  });

  // The regression this design exists to prevent: an agent pointing parts of its own home elsewhere.
  it("never writes into the home or through the agent's symlinks from the app process", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const outside = path.join(root, "provider-vault");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(home("ws1"), ".nvm", "versions"), { recursive: true });
    await symlink(outside, path.join(home("ws1"), ".nvm", "alias"));
    await symlink(outside, path.join(home("ws1"), ".nvm", "versions", "node"));
    const before = { home: await snapshot(home("ws1")), outside: await snapshot(outside) };
    const { docker } = makeDocker({ inspectStdout: "nvm" });

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(await snapshot(home("ws1"))).toEqual(before.home);
    expect(await snapshot(outside)).toEqual(before.outside);
  });

  it("never removes or recreates the running container to do it", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const { docker, calls } = makeDocker();

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(calls.filter((c) => c[0] === "rm" || c[0] === "stop")).toEqual([]);
    expect(calls.filter((c) => c[0] === "run" && c.includes("--name"))).toEqual([]);
  });

  it("runs once: later wakes and later processes see the marker", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const first = makeDocker();
    const manager = new ContainerManager(first.docker);
    await manager.ensure("ws1", "/w");
    await manager.ensure("ws1", "/w");
    expect(inspectRuns(first.calls)).toHaveLength(1);

    const second = makeDocker();
    await new ContainerManager(second.docker).ensure("ws1", "/w");
    expect(inspectRuns(second.calls)).toEqual([]);
  });

  it("only records the marker when the home is already on the image's Node", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const { docker, calls } = makeDocker({ inspectStdout: `nvm\nalias ${TARGET}\nversion ${TARGET}` });

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(applyRuns(calls)).toEqual([]);
    expect(await readFile(`${home("ws1")}.node`, "utf-8")).toBe(`${TARGET}\n`);
  });

  it.each([
    ["inspection", { failInspect: true }],
    ["delivery", { failApply: true }],
  ])("keeps the workspace usable when %s fails, and backs off before retrying", async (_stage, failure) => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    const failing = makeDocker(failure);
    const manager = new ContainerManager(failing.docker);

    await expect(manager.ensure("ws1", "/w")).resolves.toBeUndefined();
    await expect(access(`${home("ws1")}.node`)).rejects.toThrow();
    // ensure() runs on every command, so a broken home must not cost two containers per command.
    await manager.ensure("ws1", "/w");
    expect(inspectRuns(failing.calls)).toHaveLength(1);

    const later = Date.now() + 61 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await manager.ensure("ws1", "/w");
    expect(inspectRuns(failing.calls)).toHaveLength(2);
  });

  it("records the image's Node at seed time, so a new workspace never runs the upgrade", async () => {
    const ContainerManager = await loadManager();
    const { docker, calls } = makeDocker({ status: "missing" });

    await new ContainerManager(docker).ensure("ws1", "/w");

    expect(await readFile(`${home("ws1")}.node`, "utf-8")).toBe(`${TARGET}\n`);
    expect(inspectRuns(calls)).toEqual([]);
  });

  it("sweeps every seeded home at boot and shares the work with a concurrent wake", async () => {
    const ContainerManager = await loadManager();
    await seededHome("ws1");
    await mkdir(home("ws2"), { recursive: true });
    const { docker, calls } = makeDocker();
    const manager = new ContainerManager(docker);

    await Promise.all([manager.migrateAgentHomes(["ws1", "ws2"]), manager.ensure("ws1", "/w")]);

    expect(inspectRuns(calls)).toHaveLength(1);
    expect(applyRuns(calls)).toHaveLength(1);
    await expect(access(`${home("ws2")}.node`)).rejects.toThrow();
  });
});
