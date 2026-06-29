// The broker tool is the agent's only door to "privilege by location". These pin its refusals: it
// runs a script ONLY when it is both registered as privileged AND locked (deny-edit). The store's
// setPermission keeps those coupled, but a hand-edited store on disk could decouple them — so the
// tool re-checks at trigger time and fails closed rather than running a script the agent could rewrite.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Set before the store module (read at import) loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "privscript-"));
process.env.WORKSPACES_ROOT = TMP;

type Store = typeof import("../../infra/docker/agentPermissionStore");
type Tool = typeof import("./runPrivilegedScript");
let store: Store;
let RunPrivilegedScriptTool: Tool["RunPrivilegedScriptTool"];

beforeAll(async () => {
  store = await import("../../infra/docker/agentPermissionStore");
  ({ RunPrivilegedScriptTool } = await import("./runPrivilegedScript"));
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fakeContainers(run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" })) {
  return { runPrivilegedScript: run } as never;
}

describe("RunPrivilegedScriptTool", () => {
  it("runs a script that is registered AND locked", async () => {
    store.savePermissions("ok", { denyRead: [], denyEdit: ["deploy.sh"], privilegedScripts: ["deploy.sh"] });
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "done", stderr: "" });
    const tool = new RunPrivilegedScriptTool("ok", "/data/ok", fakeContainers(run));
    const out = await tool.invoke({ script_path: "deploy.sh" });
    expect(run).toHaveBeenCalledWith("ok", "/data/ok", "deploy.sh");
    expect(out).toContain("done");
  });

  it("refuses a path that is not registered", async () => {
    store.savePermissions("unreg", { denyRead: [], denyEdit: [], privilegedScripts: [] });
    const run = vi.fn();
    const tool = new RunPrivilegedScriptTool("unreg", "/data/unreg", fakeContainers(run));
    const out = await tool.invoke({ script_path: "evil.sh" });
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatch(/not registered for execution/);
  });

  it("accepts a deny-read (hidden) script without an explicit privileged registration", async () => {
    store.savePermissions("hidden", { denyRead: ["secret.sh"], denyEdit: [], privilegedScripts: [] });
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ran", stderr: "" });
    const tool = new RunPrivilegedScriptTool("hidden", "/data/hidden", fakeContainers(run));
    const out = await tool.invoke({ script_path: "secret.sh" });
    expect(run).toHaveBeenCalledWith("hidden", "/data/hidden", "secret.sh");
    expect(out).toContain("ran");
  });

  it("refuses a privileged script that is NOT locked (hand-edited store)", async () => {
    // Decoupled state setPermission would never produce: privileged but missing from deny-edit.
    store.savePermissions("decoupled", { denyRead: [], denyEdit: [], privilegedScripts: ["deploy.sh"] });
    const run = vi.fn();
    const tool = new RunPrivilegedScriptTool("decoupled", "/data/decoupled", fakeContainers(run));
    const out = await tool.invoke({ script_path: "deploy.sh" });
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatch(/not locked \(deny-edit\)/);
  });

  it("accepts a script locked via an ancestor folder (deny-edit on the parent dir)", async () => {
    store.savePermissions("ancestor", { denyRead: [], denyEdit: ["bin"], privilegedScripts: ["bin/deploy.sh"] });
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ran", stderr: "" });
    const tool = new RunPrivilegedScriptTool("ancestor", "/data/ancestor", fakeContainers(run));
    const out = await tool.invoke({ script_path: "bin/deploy.sh" });
    expect(run).toHaveBeenCalled();
    expect(out).toContain("ran");
  });

  it("accepts a script whose PRIVILEGE is inherited from an ancestor folder (trickle-down)", async () => {
    // Privilege keyed on the folder itself (which auto-locks it); a script beneath it inherits both.
    store.savePermissions("privdir", { denyRead: [], denyEdit: ["bin"], privilegedScripts: ["bin"] });
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ran", stderr: "" });
    const tool = new RunPrivilegedScriptTool("privdir", "/data/privdir", fakeContainers(run));
    const out = await tool.invoke({ script_path: "bin/deploy.sh" });
    expect(run).toHaveBeenCalledWith("privdir", "/data/privdir", "bin/deploy.sh");
    expect(out).toContain("ran");
  });

  it("refuses a path outside the workspace", async () => {
    const run = vi.fn();
    const tool = new RunPrivilegedScriptTool("ws", "/data/ws", fakeContainers(run));
    const out = await tool.invoke({ script_path: "../escape.sh" });
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatch(/outside the workspace/);
  });
});
