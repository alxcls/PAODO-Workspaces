// Every home moves to the image's Node; the old default and any globals left on it are reported.
// The scripts run for real, under sh.
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
    expect(planNodeUpgrade(facts({ nvm: false }), TARGET)).toEqual({ action: "skip", reason: "no_nvm" });
  });

  it("moves a legacy home still on the image's default", () => {
    const home = facts({ alias: "22.23.2", installed: ["22.23.2"], globals: { "22.23.2": ["npm", "corepack"] } });
    expect(planNodeUpgrade(home, TARGET)).toEqual({
      action: "deliver",
      copy: true,
      move: true,
      previousDefault: "22.23.2",
      globalsLeftBehind: [],
    });
  });

  it("moves a default the agent chose, and says what it replaced", () => {
    const home = facts({ alias: "20.19.0", installed: ["20.19.0", "22.23.2"] });
    expect(planNodeUpgrade(home, TARGET)).toMatchObject({ move: true, previousDefault: "20.19.0" });
  });

  it("moves even with agent-installed globals, naming the ones left on the old version", () => {
    const home = facts({
      alias: "22",
      installed: ["22.9.0", "22.23.2"],
      globals: { "22.23.2": ["npm", "typescript", "@scope/cli"], "22.9.0": ["eslint"] },
    });
    expect(planNodeUpgrade(home, TARGET)).toMatchObject({
      move: true,
      globalsLeftBehind: ["@scope/cli", "typescript"],
    });
  });

  it("moves an alias nvm resolves loosely, keeping it verbatim for the log", () => {
    expect(planNodeUpgrade(facts({ alias: "lts/*", installed: ["22.23.2"] }), TARGET)).toMatchObject({
      move: true,
      previousDefault: "lts/*",
      globalsLeftBehind: [],
    });
  });

  it("does nothing to a home already installed and defaulted on the target", () => {
    const home = facts({ alias: TARGET, installed: ["22.23.2", TARGET], globals: { [TARGET]: ["typescript"] } });
    expect(planNodeUpgrade(home, TARGET)).toMatchObject({ copy: false, move: false, globalsLeftBehind: [] });
  });

  it("applies the same rule to a later image bump", () => {
    expect(planNodeUpgrade(facts({ alias: TARGET, installed: [TARGET] }), "26.4.0")).toMatchObject({
      copy: true,
      move: true,
      previousDefault: TARGET,
    });
  });

  it("moves a home with no default alias at all", () => {
    expect(planNodeUpgrade(facts({ installed: ["22.23.2"] }), TARGET)).toMatchObject({
      move: true,
      previousDefault: null,
    });
  });
});
