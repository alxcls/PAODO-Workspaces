// The recipe is the only record that a workspace ever had a system package, so what it keeps — and
// what it refuses to keep — decides what a rebuilt container comes back with.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { readAptRecipe, recordAptPackages } from "./aptRecipe";
import { workspaceAptRecipeFile } from "./paths";

// WORKSPACES_ROOT is a per-file temp dir (vitest.setup.ts), so each id below starts with no recipe.
let n = 0;
const freshWorkspace = () => `ws-${++n}`;

describe("apt recipe", () => {
  it("has nothing to replay for a workspace that never installed anything", () => {
    expect(readAptRecipe(freshWorkspace())).toEqual([]);
  });

  it("records what was installed, and keeps recording across calls", () => {
    const ws = freshWorkspace();
    recordAptPackages(ws, ["ffmpeg"]);
    recordAptPackages(ws, ["imagemagick", "poppler-utils"]);

    expect(readAptRecipe(ws)).toEqual(["ffmpeg", "imagemagick", "poppler-utils"]);
  });

  // Two specs for one package would be handed to apt-get together, where the pin and the bare name
  // contradict each other. The newer spec is the one the agent asked for most recently.
  it("supersedes a package rather than queueing a second spec for it", () => {
    const ws = freshWorkspace();
    recordAptPackages(ws, ["ffmpeg", "htop"]);
    recordAptPackages(ws, ["ffmpeg=7:6.1.1-3"]);

    expect(readAptRecipe(ws)).toEqual(["ffmpeg=7:6.1.1-3", "htop"]);
  });

  it("does not grow when the same package is installed twice", () => {
    const ws = freshWorkspace();
    recordAptPackages(ws, ["htop"]);
    recordAptPackages(ws, ["htop"]);

    expect(readAptRecipe(ws)).toEqual(["htop"]);
  });

  // It lives beside the home rather than inside it, so it is outside the /home/dev mount and the
  // agent whose packages it describes cannot reach it.
  it("is stored next to the home, not inside it", () => {
    const ws = freshWorkspace();
    recordAptPackages(ws, ["htop"]);

    const file = workspaceAptRecipeFile(ws);
    expect(path.basename(file)).toBe(`${ws}.apt.json`);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(["htop"]);
  });

  // A replay feeds these straight to apt-get. A corrupt file must degrade to "install nothing",
  // never to a crash on the container-create path or a non-string reaching the argv.
  it("replays nothing rather than throwing when the file is unreadable", () => {
    const ws = freshWorkspace();
    const file = workspaceAptRecipeFile(ws);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");

    expect(readAptRecipe(ws)).toEqual([]);
  });

  it("drops entries that are not package specs", () => {
    const ws = freshWorkspace();
    const file = workspaceAptRecipeFile(ws);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(["htop", null, 42, { pkg: "ffmpeg" }]));

    expect(readAptRecipe(ws)).toEqual(["htop"]);
  });
});
