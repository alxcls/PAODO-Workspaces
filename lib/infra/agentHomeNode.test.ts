// A home's default Node may only move while it is still the image's own choice, so the agent's
// deliberate pins and global tools survive an image upgrade.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { imageNodeVersion, planNodeUpgrade, setDefaultAlias, type AgentHomePaths } from "./agentHomeNode";

const TARGET = "24.21.0";
let root: string;
let paths: AgentHomePaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-node-"));
  paths = {
    homeDir: path.join(root, "home"),
    seededMarker: path.join(root, "home.seeded"),
    nodeMarker: path.join(root, "home.node"),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface HomeSpec {
  alias?: string;
  versions?: Record<string, string[]>;
  marker?: string;
  seeded?: boolean;
  nvm?: boolean;
}

async function makeHome({ alias, versions = {}, marker, seeded = true, nvm = true }: HomeSpec) {
  const nvmDir = path.join(paths.homeDir, ".nvm");
  await mkdir(path.join(nvmDir, "alias"), { recursive: true });
  if (nvm) await writeFile(path.join(nvmDir, "nvm.sh"), "");
  if (alias !== undefined) await writeFile(path.join(nvmDir, "alias", "default"), `${alias}\n`);
  for (const [version, globals] of Object.entries(versions)) {
    const dir = path.join(nvmDir, "versions", "node", `v${version}`);
    await mkdir(path.join(dir, "bin"), { recursive: true });
    await writeFile(path.join(dir, "bin", "node"), "");
    for (const pkg of globals) await mkdir(path.join(dir, "lib", "node_modules", pkg), { recursive: true });
  }
  if (seeded) await writeFile(paths.seededMarker, "");
  if (marker) await writeFile(paths.nodeMarker, `${marker}\n`);
}

describe("imageNodeVersion", () => {
  it("reads the exact version the workspace Dockerfile installs", async () => {
    expect(await imageNodeVersion(path.resolve("Dockerfile.workspace"))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns null when the Dockerfile can't be read", async () => {
    expect(await imageNodeVersion(path.join(root, "missing"))).toBeNull();
  });
});

describe("planNodeUpgrade", () => {
  it("does nothing once the marker names the target", async () => {
    await makeHome({ alias: TARGET, versions: { [TARGET]: ["npm"] }, marker: TARGET });
    expect(await planNodeUpgrade(paths, TARGET)).toEqual({ action: "none" });
  });

  it("leaves a home that was never seeded to the seed", async () => {
    await makeHome({ alias: "22.23.2", seeded: false });
    expect(await planNodeUpgrade(paths, TARGET)).toEqual({ action: "skip", reason: "not_seeded" });
  });

  it("skips a home whose nvm is gone", async () => {
    await makeHome({ alias: "22.23.2", nvm: false });
    expect(await planNodeUpgrade(paths, TARGET)).toEqual({ action: "skip", reason: "no_nvm" });
  });

  it("moves a legacy home still on the image's exact default", async () => {
    await makeHome({ alias: "22.23.2", versions: { "22.23.2": ["npm", "corepack"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toEqual({
      action: "deliver",
      copy: true,
      previous: "22.23.2",
      default: "move",
      globals: [],
    });
  });

  it("resolves the major-only legacy default to its highest install", async () => {
    await makeHome({ alias: "22", versions: { "22.9.0": ["npm"], "22.18.0": ["npm"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toMatchObject({ previous: "22.18.0", default: "move" });
  });

  it("keeps a default the agent chose", async () => {
    await makeHome({ alias: "20.19.0", versions: { "20.19.0": ["npm"], "22.23.2": ["npm"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toMatchObject({ action: "deliver", copy: true, default: "custom" });
  });

  it("keeps the default when the agent installed global packages on it", async () => {
    await makeHome({ alias: "22.23.2", versions: { "22.23.2": ["npm", "typescript", "@scope/cli"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toMatchObject({
      default: "global_packages",
      globals: ["@scope/cli", "typescript"],
    });
  });

  it("skips the copy when the target is already installed and default", async () => {
    await makeHome({ alias: TARGET, versions: { "22.23.2": ["npm"], [TARGET]: ["npm"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toMatchObject({ copy: false, default: "current" });
  });

  it("follows the marker rather than the legacy list once one was written", async () => {
    await makeHome({ alias: "24.20.0", versions: { "24.20.0": ["npm"] }, marker: "24.20.0" });
    expect(await planNodeUpgrade(paths, "24.22.0")).toMatchObject({ previous: "24.20.0", default: "move" });
  });

  it("moves a home with no default alias at all", async () => {
    await makeHome({ versions: { "22.23.2": ["npm"] } });
    expect(await planNodeUpgrade(paths, TARGET)).toMatchObject({ previous: null, default: "move" });
  });
});

describe("setDefaultAlias", () => {
  it("writes nvm's alias format, creating the alias dir if needed", async () => {
    await setDefaultAlias(paths.homeDir, TARGET);
    expect(await readFile(path.join(paths.homeDir, ".nvm", "alias", "default"), "utf-8")).toBe(`${TARGET}\n`);
  });
});
