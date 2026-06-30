import { describe, it, expect, vi, beforeEach } from "vitest";

const priv = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock("../../infra/permissionStore", () => ({
  isPrivileged: (_ws: string, p: string) => priv.set.has(p),
}));

import { RunPrivilegedScriptTool } from "./runPrivilegedScript";
import type { PrivilegedRunner } from "../interfaces";

let lastPrivileged: { cmd: string[]; cwd?: string } | undefined;
const runner: PrivilegedRunner = {
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  execAsRoot: async () => ({ code: 0, stdout: "", stderr: "" }),
  execAsPrivileged: async (cmd, opts) => {
    lastPrivileged = { cmd, cwd: opts?.cwd };
    return { code: 0, stdout: "done", stderr: "" };
  },
};

const tool = () => new RunPrivilegedScriptTool("ws", runner);

beforeEach(() => {
  priv.set = new Set();
  lastPrivileged = undefined;
});

describe("RunPrivilegedScriptTool", () => {
  it("refuses a path that is not privileged", async () => {
    const out = await tool().invoke({ path: "deploy.sh" });
    expect(out).toMatch(/not a privileged script/);
    expect(lastPrivileged).toBeUndefined();
  });

  it("refuses a path outside the workspace", async () => {
    const out = await tool().invoke({ path: "../../etc/passwd" });
    expect(out).toMatch(/outside the workspace/);
  });

  it("runs a privileged script as privd from its own directory", async () => {
    priv.set.add("scripts/deploy.sh");
    const out = await tool().invoke({ path: "scripts/deploy.sh", runtime: "bash", args: ["--prod"] });
    expect(lastPrivileged?.cmd).toEqual(["bash", "/workspace/scripts/deploy.sh", "--prod"]);
    expect(lastPrivileged?.cwd).toBe("/workspace/scripts");
    expect(out).toContain("done");
  });

  it("executes the script directly when no runtime is given", async () => {
    priv.set.add("run.sh");
    await tool().invoke({ path: "run.sh" });
    expect(lastPrivileged?.cmd).toEqual(["/workspace/run.sh"]);
  });
});
