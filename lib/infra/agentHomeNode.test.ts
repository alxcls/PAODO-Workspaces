// A home's default Node may only move while it is still the image's own choice, so the agent's
// deliberate pins and global tools survive an image upgrade. The scripts run for real, under sh.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  APPLY_NODE_SCRIPT,
  INSPECT_HOME_SCRIPT,
  imageNodeVersion,
  parseHomeFacts,
  planNodeUpgrade,
  type HomeFacts,
} from "./agentHomeNode";

const TARGET = "24.21.0";
let root: string;
let home: string;
let image: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-node-"));
  home = path.join(root, "home");
  image = path.join(root, "image-node");
  await mkdir(path.join(image, `v${TARGET}`, "bin"), { recursive: true });
  await writeFile(path.join(image, `v${TARGET}`, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function nodeVersion(version: string, globals: string[] = ["npm", "corepack"], healthy = true) {
  const dir = path.join(home, ".nvm", "versions", "node", `v${version}`);
  await mkdir(path.join(dir, "bin"), { recursive: true });
  if (healthy) await writeFile(path.join(dir, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  for (const pkg of globals) await mkdir(path.join(dir, "lib", "node_modules", pkg), { recursive: true });
}

async function nvm(alias?: string) {
  await mkdir(path.join(home, ".nvm", "alias"), { recursive: true });
  await writeFile(path.join(home, ".nvm", "nvm.sh"), "# nvm\n");
  if (alias !== undefined) await writeFile(path.join(home, ".nvm", "alias", "default"), `${alias}\n`);
}

const run = (script: string, args: string[] = []) =>
  execFileSync("sh", ["-c", script, "sh", ...args], { env: { ...process.env, SEED: home, SRC: image } }).toString();
const inspect = () => parseHomeFacts(run(INSPECT_HOME_SCRIPT));
const facts = (f: Partial<HomeFacts>): HomeFacts => ({ nvm: true, alias: null, installed: [], globals: {}, ...f });

describe("imageNodeVersion", () => {
  it("reads the exact version the workspace Dockerfile installs", async () => {
    expect(await imageNodeVersion(path.resolve("Dockerfile.workspace"))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns null when the Dockerfile can't be read", async () => {
    expect(await imageNodeVersion(path.join(root, "missing"))).toBeNull();
  });
});

describe("INSPECT_HOME_SCRIPT + parseHomeFacts", () => {
  it("reports nvm, the default, healthy versions and every global package", async () => {
    await nvm("22.23.2");
    await nodeVersion("22.23.2", ["npm", "corepack", "typescript", "@scope/cli"]);
    await nodeVersion("20.19.0", [], false);

    expect(inspect()).toEqual({
      nvm: true,
      alias: "22.23.2",
      installed: ["22.23.2"],
      globals: { "22.23.2": expect.arrayContaining(["npm", "corepack", "typescript", "@scope/cli"]) },
    });
  });

  it("reports an empty home as having no nvm", async () => {
    await mkdir(home, { recursive: true });
    expect(inspect()).toEqual({ nvm: false, alias: null, installed: [], globals: {} });
  });

  it("drops lines it does not recognise instead of trusting them", () => {
    expect(parseHomeFacts("nvm\nversion not-a-version\nglobal 1.2 x\nsomething else\nversion 24.21.0")).toEqual(
      facts({ installed: ["24.21.0"] }),
    );
  });
});

describe("APPLY_NODE_SCRIPT", () => {
  it("copies the image's Node in and makes it the default, leaving older versions alone", async () => {
    await nvm("22.23.2");
    await nodeVersion("22.23.2");

    run(APPLY_NODE_SCRIPT, [TARGET, "1", "1"]);

    await expect(
      access(path.join(home, ".nvm", "versions", "node", `v${TARGET}`, "bin", "node")),
    ).resolves.toBeUndefined();
    await expect(access(path.join(home, ".nvm", "versions", "node", "v22.23.2"))).resolves.toBeUndefined();
    expect(await readFile(path.join(home, ".nvm", "alias", "default"), "utf-8")).toBe(`${TARGET}\n`);
    expect((await readdir(path.join(home, ".nvm", "versions", "node"))).sort()).toEqual(["v22.23.2", `v${TARGET}`]);
    expect(await readdir(path.join(home, ".nvm", "alias"))).toEqual(["default"]);
  });

  it("delivers without touching the default when told not to move it", async () => {
    await nvm("20.19.0");
    await nodeVersion("20.19.0");

    run(APPLY_NODE_SCRIPT, [TARGET, "1", "0"]);

    expect(inspect().installed.sort()).toEqual(["20.19.0", TARGET]);
    expect(await readFile(path.join(home, ".nvm", "alias", "default"), "utf-8")).toBe("20.19.0\n");
  });

  it("replaces a half-present copy of the target", async () => {
    await nvm("22.23.2");
    await nodeVersion(TARGET, [], false);

    run(APPLY_NODE_SCRIPT, [TARGET, "1", "0"]);

    expect(inspect().installed).toEqual([TARGET]);
  });
});

describe("planNodeUpgrade", () => {
  it("skips a home whose nvm is gone", () => {
    expect(planNodeUpgrade(facts({ nvm: false }), null, TARGET)).toEqual({ action: "skip", reason: "no_nvm" });
  });

  it("moves a legacy home still on the image's exact default", () => {
    const home = facts({ alias: "22.23.2", installed: ["22.23.2"], globals: { "22.23.2": ["npm", "corepack"] } });
    expect(planNodeUpgrade(home, null, TARGET)).toEqual({
      action: "deliver",
      copy: true,
      previous: "22.23.2",
      default: "move",
      globals: [],
    });
  });

  it("resolves the major-only legacy default to its highest install", () => {
    const home = facts({ alias: "22", installed: ["22.9.0", "22.18.0"] });
    expect(planNodeUpgrade(home, null, TARGET)).toMatchObject({ previous: "22.18.0", default: "move" });
  });

  it("keeps a default the agent chose", () => {
    const home = facts({ alias: "20.19.0", installed: ["20.19.0", "22.23.2"] });
    expect(planNodeUpgrade(home, null, TARGET)).toMatchObject({ copy: true, default: "custom" });
  });

  it("keeps the default when the agent installed global packages on it", () => {
    const home = facts({
      alias: "22.23.2",
      installed: ["22.23.2"],
      globals: { "22.23.2": ["npm", "typescript", "@scope/cli"] },
    });
    expect(planNodeUpgrade(home, null, TARGET)).toMatchObject({
      default: "global_packages",
      globals: ["@scope/cli", "typescript"],
    });
  });

  it("skips the copy when the target is already installed and default", () => {
    const home = facts({ alias: TARGET, installed: ["22.23.2", TARGET] });
    expect(planNodeUpgrade(home, null, TARGET)).toMatchObject({ copy: false, default: "current" });
  });

  it("follows the marker on a later image bump, not the legacy list", () => {
    const home = facts({ alias: TARGET, installed: [TARGET] });
    expect(planNodeUpgrade(home, TARGET, "26.4.0")).toMatchObject({ copy: true, previous: TARGET, default: "move" });
    expect(planNodeUpgrade(facts({ alias: "22.23.2", installed: ["22.23.2"] }), TARGET, "26.4.0")).toMatchObject({
      default: "custom",
    });
  });

  it("moves a home with no default alias at all", () => {
    expect(planNodeUpgrade(facts({ installed: ["22.23.2"] }), null, TARGET)).toMatchObject({
      previous: null,
      default: "move",
    });
  });
});
