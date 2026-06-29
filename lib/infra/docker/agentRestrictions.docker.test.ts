// END-TO-END: feed the APP-COMPOSED mount args (composeAgentMounts) to a real `docker run` under
// the same hardening as the workspace container, and assert the kernel enforces the policy:
//   - deny-read file  -> reads the stub, NOT the real secret
//   - deny-edit file  -> append returns EROFS; the mountpoint also blocks rm (EBUSY)
//   - normal file     -> writable (control)
// The earlier spike proved these mount mechanics in isolation; this proves the store -> args path
// the app actually runs produces them. Auto-skips when Docker is unavailable so `npm test` stays
// green in CI without a daemon.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_DOCKER = dockerAvailable();
const d = HAS_DOCKER ? describe : describe.skip;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentperms-e2e-"));
process.env.WORKSPACES_ROOT = TMP;

// Same cap set as the real workspace container (containerManager.ts): drop ALL, add back the
// minimal apt/chown set. uid 1000 + no-new-privileges, like the agent's shell.
const CAPS = [
  "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
  "--cap-add", "FOWNER", "--cap-add", "FSETID", "--cap-add", "SETGID", "--cap-add", "SETUID",
];

let composeAgentMounts: typeof import("./agentPermissionStore").composeAgentMounts;
let savePermissions: typeof import("./agentPermissionStore").savePermissions;

beforeAll(async () => {
  const store = await import("./agentPermissionStore");
  composeAgentMounts = store.composeAgentMounts;
  savePermissions = store.savePermissions;
  if (HAS_DOCKER) execFileSync("docker", ["pull", "-q", "ubuntu:24.04"], { stdio: "ignore" });
}, 180_000);

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

d("composed restrictions under real docker", () => {
  it("enforces deny-read (stub), deny-edit (EROFS/EBUSY), and leaves normal files writable", () => {
    const id = "ws_e2e";
    const dir = path.join(TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "normal.txt"), "writable\n");
    fs.writeFileSync(path.join(dir, "secret.txt"), "TOP SECRET CONTENT\n");
    fs.writeFileSync(path.join(dir, "config.yaml"), "k: v\n");

    savePermissions(id, { denyRead: ["secret.txt"], denyEdit: ["config.yaml"], privilegedScripts: [] });
    const restrictionArgs = composeAgentMounts(id, dir, ""); // bind mode
    expect(restrictionArgs.length).toBeGreaterThan(0); // sanity: it actually composed mounts

    // A failed `>>` redirection errors at the shell-redirection level, so capture each command
    // (redirect included) inside a `{ …; } 2>&1` group whose stderr we collect.
    const test = `
      cd /tmp
      echo "READ:$(cat /workspace/secret.txt)"
      EDIT=$( { echo x >> /workspace/config.yaml ; } 2>&1 ) && echo "EDIT:wrote" || echo "EDIT:$EDIT"
      RM=$( { rm -f /workspace/config.yaml ; } 2>&1 ) && echo "RM:removed" || echo "RM:$RM"
      NORMAL=$( { echo y >> /workspace/normal.txt ; } 2>&1 ) && echo "NORMAL:wrote" || echo "NORMAL:$NORMAL"
    `;

    const out = execFileSync("docker", [
      "run", "--rm", "-u", "1000:1000", ...CAPS,
      "--security-opt", "no-new-privileges:true",
      "-v", `${dir}:/workspace`,
      ...restrictionArgs,
      "ubuntu:24.04", "bash", "-c", test,
    ], { encoding: "utf-8" });

    // deny-read: the agent sees the stub, never the real bytes.
    expect(out).toContain("READ:[restricted: content withheld by workspace policy]");
    expect(out).not.toContain("TOP SECRET CONTENT");
    // deny-edit: write rejected read-only, and the mountpoint blocks deletion.
    expect(out).toMatch(/EDIT:.*(Read-only file system|Operation not permitted)/);
    expect(out).toMatch(/RM:.*(Device or resource busy|Read-only file system|Operation not permitted)/);
    expect(out).not.toContain("RM:removed");
    // control: a normal file stays writable.
    expect(out).toContain("NORMAL:wrote");
  }, 120_000);

  // The production topology: a Docker named volume the daemon addresses by subpath (the app-container
  // source paths are invisible to it). We stage the workspace files AND the deny-read stubs into one
  // volume (exactly as prod does — both live under WORKSPACES_ROOT, which IS the volume), then drive
  // `docker run` with the volume-subpath args composeAgentMounts emits in volume mode.
  it("enforces the same policy in VOLUME mode (volume-subpath mounts)", () => {
    const VOL = "paodo-e2e-restrictions-vol";
    const id = "ws_vol_e2e";
    const dir = path.join(TMP, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "normal.txt"), "writable\n");
    fs.writeFileSync(path.join(dir, "secret.txt"), "TOP SECRET CONTENT\n");
    fs.writeFileSync(path.join(dir, "config.yaml"), "k: v\n");

    savePermissions(id, { denyRead: ["secret.txt"], denyEdit: ["config.yaml"], privilegedScripts: [] });
    // Volume mode: returns `--mount type=volume,...,volume-subpath=...,readonly` and writes the stub
    // assets under TMP/.agent-permissions (which we copy into the volume root below).
    const restrictionArgs = composeAgentMounts(id, dir, VOL);
    expect(restrictionArgs).not.toContain("-v");
    expect(restrictionArgs.length).toBeGreaterThan(0);

    // Stage TMP (workspace dirs + .agent-permissions stubs) into the named volume's root, mirroring
    // the app container's `workspaces:/app/data` mount.
    execFileSync("docker", ["volume", "rm", "-f", VOL], { stdio: "ignore" });
    try {
      execFileSync("docker", ["volume", "create", VOL], { stdio: "ignore" });
      // chown to uid 1000 so the agent user owns the tree (prod does this via its ownership sweep);
      // otherwise root-owned files fail the DAC check before the read-only mount can return EROFS,
      // which would mask the policy we're actually testing.
      execFileSync("docker", [
        "run", "--rm", "-v", `${VOL}:/vol`, "-v", `${TMP}:/src:ro`,
        "ubuntu:24.04", "bash", "-c", "cp -a /src/. /vol/ && chown -R 1000:1000 /vol",
      ], { stdio: "ignore" });

      const test = `
        cd /tmp
        echo "READ:$(cat /workspace/secret.txt)"
        EDIT=$( { echo x >> /workspace/config.yaml ; } 2>&1 ) && echo "EDIT:wrote" || echo "EDIT:$EDIT"
        RM=$( { rm -f /workspace/config.yaml ; } 2>&1 ) && echo "RM:removed" || echo "RM:$RM"
        NORMAL=$( { echo y >> /workspace/normal.txt ; } 2>&1 ) && echo "NORMAL:wrote" || echo "NORMAL:$NORMAL"
      `;

      const out = execFileSync("docker", [
        "run", "--rm", "-u", "1000:1000", ...CAPS,
        "--security-opt", "no-new-privileges:true",
        // Base mount: the workspace by subpath, exactly like containerManager.buildVolumeArg in prod.
        "--mount", `type=volume,source=${VOL},target=/workspace,volume-subpath=${id}`,
        ...restrictionArgs,
        "ubuntu:24.04", "bash", "-c", test,
      ], { encoding: "utf-8" });

      expect(out).toContain("READ:[restricted: content withheld by workspace policy]");
      expect(out).not.toContain("TOP SECRET CONTENT");
      expect(out).toMatch(/EDIT:.*(Read-only file system|Operation not permitted)/);
      expect(out).toMatch(/RM:.*(Device or resource busy|Read-only file system|Operation not permitted)/);
      expect(out).not.toContain("RM:removed");
      expect(out).toContain("NORMAL:wrote");
    } finally {
      execFileSync("docker", ["volume", "rm", "-f", VOL], { stdio: "ignore" });
    }
  }, 180_000);
});
