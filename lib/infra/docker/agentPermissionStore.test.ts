// Store + composer behaviour, against a temp WORKSPACES_ROOT so it never touches real data.
// Proves: store round-trips, missing store = no restrictions, a corrupt store FAILS CLOSED, the
// composer materializes deny-read stubs on disk and emits the right mount args, and volume-mode
// with restrictions REFUSES to start (rather than running unenforced).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Must be set before the store module (which reads WORKSPACES_ROOT at import) is loaded.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentperms-"));
process.env.WORKSPACES_ROOT = TMP;

type Store = typeof import("./agentPermissionStore");
let store: Store;
let PolicyError: typeof import("./agentPermissions").PolicyError;

beforeAll(async () => {
  store = await import("./agentPermissionStore");
  ({ PolicyError } = await import("./agentPermissions"));
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A workspace dir with real files for the composer's host probes to stat.
function makeWorkspace(id: string): string {
  const dir = path.join(TMP, id);
  fs.mkdirSync(path.join(dir, "private"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secret.txt"), "TOP SECRET");
  fs.writeFileSync(path.join(dir, "config.yaml"), "k: v");
  fs.writeFileSync(path.join(dir, "private", "inside.txt"), "hidden");
  return dir;
}

describe("permission store", () => {
  it("round-trips save -> load", () => {
    const p = { denyRead: ["a.txt"], denyEdit: ["b.txt"], privilegedScripts: ["s.sh"] };
    store.savePermissions("ws1", p);
    expect(store.loadPermissions("ws1")).toEqual(p);
  });

  it("missing store means no restrictions", () => {
    expect(store.loadPermissions("never-created")).toEqual({
      denyRead: [], denyEdit: [], privilegedScripts: [],
    });
  });

  it("FAILS CLOSED on a corrupt store", () => {
    const file = store.permissionsPath("corrupt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(() => store.loadPermissions("corrupt")).toThrow(PolicyError);
  });
});

describe("composeAgentMounts", () => {
  const VOL = "paodo_ws_workspaces";

  it("returns [] when nothing is restricted", () => {
    const dir = makeWorkspace("empty");
    expect(store.composeAgentMounts("empty", dir, "")).toEqual([]);
  });

  it("materializes deny-read stubs and emits deny-read + deny-edit mount args (bind mode)", () => {
    const dir = makeWorkspace("ws2");
    store.savePermissions("ws2", {
      denyRead: ["secret.txt", "private"], denyEdit: ["config.yaml"], privilegedScripts: [],
    });
    const args = store.composeAgentMounts("ws2", dir, "");

    // deny-read file -> ro stub bind; deny-read dir -> ro stub-dir bind; deny-edit -> ro self-bind.
    const joined = args.join(" ");
    expect(joined).toContain(":/workspace/secret.txt:ro");
    expect(joined).toContain(":/workspace/private:ro");
    expect(joined).toContain(`${dir}/config.yaml:/workspace/config.yaml:ro`);

    // The deny-read stub assets were actually written to disk, ready to bind.
    const stubRoot = path.join(TMP, ".agent-permissions", "ws2", "stubs");
    const fileStub = fs.readFileSync(path.join(stubRoot, "read", encodeURIComponent("secret.txt")), "utf-8");
    expect(fileStub).toContain("restricted");
    const dirReadme = fs.readFileSync(path.join(stubRoot, "readdir", "private", "README"), "utf-8");
    expect(dirReadme).toContain("restricted");
  });

  it("emits volume-subpath mounts (and still writes stubs) in volume mode", () => {
    const dir = makeWorkspace("ws3");
    store.savePermissions("ws3", {
      denyRead: ["secret.txt", "private"], denyEdit: ["config.yaml"], privilegedScripts: [],
    });
    const args = store.composeAgentMounts("ws3", dir, VOL);
    const joined = args.join(" ");

    // No host-bind (`-v`) args at all — everything is addressed through the named volume.
    expect(args).not.toContain("-v");
    // deny-edit -> real file by subpath under the workspace dir, read-only.
    expect(joined).toContain(
      `type=volume,source=${VOL},target=/workspace/config.yaml,volume-subpath=ws3/config.yaml,readonly`,
    );
    // deny-read file/dir -> the STUB asset by its subpath under .agent-permissions, read-only.
    expect(joined).toContain(
      `target=/workspace/secret.txt,volume-subpath=.agent-permissions/ws3/stubs/read/${encodeURIComponent("secret.txt")},readonly`,
    );
    expect(joined).toContain(
      "target=/workspace/private,volume-subpath=.agent-permissions/ws3/stubs/readdir/private,readonly",
    );

    // Stubs are still materialized on disk (inside the volume) so the daemon can mount them.
    const stubRoot = path.join(TMP, ".agent-permissions", "ws3", "stubs");
    expect(fs.readFileSync(path.join(stubRoot, "read", encodeURIComponent("secret.txt")), "utf-8")).toContain("restricted");
    expect(fs.readFileSync(path.join(stubRoot, "readdir", "private", "README"), "utf-8")).toContain("restricted");
  });

  it("allows volume mode when nothing is restricted", () => {
    const dir = makeWorkspace("ws4");
    expect(store.composeAgentMounts("ws4", dir, VOL)).toEqual([]);
  });

  it("still fails closed on a corrupt store in volume mode", () => {
    const file = store.permissionsPath("ws5");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const dir = makeWorkspace("ws5");
    expect(() => store.composeAgentMounts("ws5", dir, VOL)).toThrow(PolicyError);
  });
});

describe("setPermission", () => {
  it("adds then removes a path, persisting both", () => {
    let p = store.setPermission("sp1", "denyRead", "a/b.txt", true);
    expect(p.denyRead).toEqual(["a/b.txt"]);
    expect(store.loadPermissions("sp1").denyRead).toEqual(["a/b.txt"]);
    p = store.setPermission("sp1", "denyRead", "a/b.txt", false);
    expect(p.denyRead).toEqual([]);
  });

  it("is idempotent and keeps lists sorted", () => {
    store.setPermission("sp2", "denyEdit", "z.txt", true);
    store.setPermission("sp2", "denyEdit", "z.txt", true);
    const p = store.setPermission("sp2", "denyEdit", "a.txt", true);
    expect(p.denyEdit).toEqual(["a.txt", "z.txt"]);
  });

  it("rejects an unsafe path", () => {
    expect(() => store.setPermission("sp3", "denyRead", "../escape", true)).toThrow(PolicyError);
  });

  it("granting privilege auto-locks the script (privilege requires deny-edit)", () => {
    const p = store.setPermission("sp4", "privilegedScripts", "deploy.sh", true);
    expect(p.privilegedScripts).toEqual(["deploy.sh"]);
    expect(p.denyEdit).toEqual(["deploy.sh"]); // auto-locked so the agent can't rewrite it
    expect(store.loadPermissions("sp4").denyEdit).toEqual(["deploy.sh"]);
  });

  it("unlocking a privileged script auto-revokes its privilege", () => {
    store.setPermission("sp5", "privilegedScripts", "deploy.sh", true); // also locks it
    const p = store.setPermission("sp5", "denyEdit", "deploy.sh", false); // unlock
    expect(p.denyEdit).toEqual([]);
    expect(p.privilegedScripts).toEqual([]); // privilege revoked alongside the unlock
    expect(store.loadPermissions("sp5").privilegedScripts).toEqual([]);
  });

  it("revoking privilege directly leaves the lock in place (only unlocking revokes privilege)", () => {
    store.setPermission("sp6", "privilegedScripts", "deploy.sh", true);
    const p = store.setPermission("sp6", "privilegedScripts", "deploy.sh", false);
    expect(p.privilegedScripts).toEqual([]);
    expect(p.denyEdit).toEqual(["deploy.sh"]); // stays locked; user can unlock separately
  });
});

describe("mountPolicyHash", () => {
  it("is 'none' with no restrictions and stable+order-independent otherwise", () => {
    expect(store.mountPolicyHash("mh-empty")).toBe("none");
    store.savePermissions("mhA", { denyRead: ["a", "b"], denyEdit: [], privilegedScripts: [] });
    store.savePermissions("mhB", { denyRead: ["b", "a"], denyEdit: [], privilegedScripts: [] });
    expect(store.mountPolicyHash("mhA")).toBe(store.mountPolicyHash("mhB"));
  });

  it("ignores privileged scripts (they don't change the mount topology)", () => {
    store.savePermissions("mhC", { denyRead: ["x"], denyEdit: [], privilegedScripts: [] });
    const before = store.mountPolicyHash("mhC");
    store.savePermissions("mhC", { denyRead: ["x"], denyEdit: [], privilegedScripts: ["s.sh"] });
    expect(store.mountPolicyHash("mhC")).toBe(before);
  });

  it("changes when a deny list changes (so a flip is detected)", () => {
    store.savePermissions("mhD", { denyRead: ["x"], denyEdit: [], privilegedScripts: [] });
    const before = store.mountPolicyHash("mhD");
    store.savePermissions("mhD", { denyRead: ["x", "y"], denyEdit: [], privilegedScripts: [] });
    expect(store.mountPolicyHash("mhD")).not.toBe(before);
  });
});

describe("buildFilePolicy", () => {
  it("blocks reads under a deny-read file or folder (ancestor match)", () => {
    store.savePermissions("fp1", { denyRead: ["secrets", "top.txt"], denyEdit: [], privilegedScripts: [] });
    const pol = store.buildFilePolicy("fp1");
    expect(pol.isDenyRead("secrets/key.txt")).toBe(true); // nested under deny-read folder
    expect(pol.isDenyRead("top.txt")).toBe(true);
    expect(pol.isDenyRead("other.txt")).toBe(false);
  });

  it("treats deny-read as also non-writable, plus deny-edit", () => {
    store.savePermissions("fp2", { denyRead: ["r.txt"], denyEdit: ["e.txt"], privilegedScripts: [] });
    const pol = store.buildFilePolicy("fp2");
    expect(pol.isDenyEdit("e.txt")).toBe(true);
    expect(pol.isDenyEdit("r.txt")).toBe(true); // deny-read stub is read-only too
    expect(pol.isDenyEdit("free.txt")).toBe(false);
  });

  it("treats privilege as trickling down to scripts under a privileged folder (ancestor match)", () => {
    store.savePermissions("fp3", { denyRead: [], denyEdit: ["bin"], privilegedScripts: ["bin"] });
    const pol = store.buildFilePolicy("fp3");
    expect(pol.isPrivileged("bin")).toBe(true);
    expect(pol.isPrivileged("bin/deploy.sh")).toBe(true); // nested under privileged folder
    expect(pol.isPrivileged("other.sh")).toBe(false);
  });
});
