// Pins the policy core: that a permission store composes into exactly the mount args the ADR's
// mechanics require (deny-read file -> ro stub bind; deny-read dir -> ro stub-dir bind; deny-edit
// -> ro self-bind), and that every fail-closed rule THROWS rather than passing a path through
// read-write. The spike already proved the kernel behaviour of these mounts; this proves the app
// emits them — and refuses, never silently allows, on the ambiguous inputs that sank prior drafts.

import { describe, it, expect } from "vitest";
import path from "path";
import {
  buildRestrictionMounts,
  PolicyError,
  EMPTY_PERMISSIONS,
  type AgentPermissions,
  type MountTopology,
  type PolicyProbes,
  type PathKind,
} from "./agentPermissions";

const WS = "/data/ws_abc";
const STUBS = "/data/.agent-permissions/ws_abc/stubs";

// Fake host probes: a map of relpath -> kind, plus an optional set of multi-linked paths.
function probes(kinds: Record<string, PathKind>, hardlinked: Set<string> = new Set()): PolicyProbes {
  return {
    statKind: (rel) => kinds[rel] ?? "missing",
    nlinkOf: (rel) => (hardlinked.has(rel) ? 2 : 1),
  };
}

function perms(p: Partial<AgentPermissions>): AgentPermissions {
  return { ...EMPTY_PERMISSIONS, ...p };
}

describe("buildRestrictionMounts", () => {
  it("emits no args for an empty store", () => {
    const out = buildRestrictionMounts(WS, STUBS, EMPTY_PERMISSIONS, probes({}));
    expect(out.args).toEqual([]);
    expect(out.stubs).toEqual([]);
  });

  it("deny-read FILE binds a ro stub over the path and materializes the stub", () => {
    const out = buildRestrictionMounts(
      WS, STUBS, perms({ denyRead: ["secrets/key.txt"] }), probes({ "secrets/key.txt": "file" }),
    );
    // %2F keeps the relpath unique + a valid single filename.
    const stub = `${STUBS}/read/secrets%2Fkey.txt`;
    expect(out.args).toEqual(["-v", `${stub}:/workspace/secrets/key.txt:ro`]);
    expect(out.stubs).toEqual([{ hostPath: stub, content: expect.stringContaining("restricted") }]);
  });

  it("deny-read FOLDER binds a ro stub dir carrying a README", () => {
    const out = buildRestrictionMounts(
      WS, STUBS, perms({ denyRead: ["private"] }), probes({ private: "dir" }),
    );
    const stubDir = `${STUBS}/readdir/private`;
    expect(out.args).toEqual(["-v", `${stubDir}:/workspace/private:ro`]);
    expect(out.stubs).toEqual([{ hostPath: `${stubDir}/README`, content: expect.stringContaining("restricted") }]);
  });

  it("deny-edit binds the REAL path :ro as its own mountpoint, with no stub", () => {
    const out = buildRestrictionMounts(
      WS, STUBS, perms({ denyEdit: ["config.yaml"] }), probes({ "config.yaml": "file" }),
    );
    expect(out.args).toEqual(["-v", `${WS}/config.yaml:/workspace/config.yaml:ro`]);
    expect(out.stubs).toEqual([]);
  });

  it("composes multiple restrictions in store order", () => {
    const out = buildRestrictionMounts(
      WS, STUBS,
      perms({ denyRead: ["a.txt"], denyEdit: ["b.txt"] }),
      probes({ "a.txt": "file", "b.txt": "file" }),
    );
    expect(out.args).toEqual([
      "-v", `${STUBS}/read/a.txt:/workspace/a.txt:ro`,
      "-v", `${WS}/b.txt:/workspace/b.txt:ro`,
    ]);
  });

  it("skips a deny-edit mount when deny-read already covers the same path (no duplicate mount point)", () => {
    const out = buildRestrictionMounts(
      WS, STUBS,
      perms({ denyRead: ["skills"], denyEdit: ["skills"] }),
      probes({ skills: "dir" }),
    );
    // Only the deny-read stub-dir mount — the redundant deny-edit self-bind at the same target is dropped.
    expect(out.args).toEqual(["-v", `${STUBS}/readdir/skills:/workspace/skills:ro`]);
  });

  it("skips a deny-edit mount for a file nested under a deny-read folder", () => {
    const out = buildRestrictionMounts(
      WS, STUBS,
      perms({ denyRead: ["private"], denyEdit: ["private/inside.txt"] }),
      probes({ private: "dir", "private/inside.txt": "file" }),
    );
    expect(out.args).toEqual(["-v", `${STUBS}/readdir/private:/workspace/private:ro`]);
  });

  // --- fail-closed rules: every one must THROW, never emit a pass-through ---

  it("skips a missing deny-read path (file deleted after restriction was set)", () => {
    const out = buildRestrictionMounts(WS, STUBS, perms({ denyRead: ["gone.txt"] }), probes({}));
    expect(out.args).toEqual([]);
    expect(out.stubs).toEqual([]);
  });

  it("skips a missing deny-edit path (file deleted after restriction was set)", () => {
    const out = buildRestrictionMounts(WS, STUBS, perms({ denyEdit: ["gone.txt"] }), probes({}));
    expect(out.args).toEqual([]);
    expect(out.stubs).toEqual([]);
  });

  it("FAILS CLOSED on a deny-read file with st_nlink>1 (hardlink would leak)", () => {
    expect(() =>
      buildRestrictionMounts(
        WS, STUBS, perms({ denyRead: ["secret.txt"] }),
        probes({ "secret.txt": "file" }, new Set(["secret.txt"])),
      ),
    ).toThrow(/nlink>1|hardlink/i);
  });

  it("FAILS CLOSED on a path that escapes the workspace", () => {
    expect(() => buildRestrictionMounts(WS, STUBS, perms({ denyEdit: ["../escape"] }), probes({})))
      .toThrow(PolicyError);
    expect(() => buildRestrictionMounts(WS, STUBS, perms({ denyRead: ["/etc/passwd"] }), probes({})))
      .toThrow(PolicyError);
  });
});

describe("buildRestrictionMounts (volume topology)", () => {
  // The volume root is /data; WS and STUBS both live under it, so subpaths are their /data-relative paths.
  const VOL = "paodo_ws_workspaces";
  const VOLUME: MountTopology = {
    mode: "volume",
    volumeName: VOL,
    workspaceSubdir: path.basename(WS), // "ws_abc"
    stubSubpathOf: (p) => path.relative("/data", p),
  };

  it("renders volume-subpath mounts instead of host binds — same policy, different syntax", () => {
    const out = buildRestrictionMounts(
      WS, STUBS,
      perms({ denyRead: ["secrets/key.txt", "private"], denyEdit: ["config.yaml"] }),
      probes({ "secrets/key.txt": "file", private: "dir", "config.yaml": "file" }),
      VOLUME,
    );
    // No host-bind syntax leaks through.
    expect(out.args).not.toContain("-v");
    expect(out.args).toEqual([
      // deny-read file -> the STUB asset, by its /data-relative subpath, read-only.
      "--mount",
      `type=volume,source=${VOL},target=/workspace/secrets/key.txt,volume-subpath=.agent-permissions/ws_abc/stubs/read/secrets%2Fkey.txt,readonly`,
      // deny-read dir -> the stub dir.
      "--mount",
      `type=volume,source=${VOL},target=/workspace/private,volume-subpath=.agent-permissions/ws_abc/stubs/readdir/private,readonly`,
      // deny-edit -> the REAL file under the workspace subdir.
      "--mount",
      `type=volume,source=${VOL},target=/workspace/config.yaml,volume-subpath=ws_abc/config.yaml,readonly`,
    ]);
    // Stub assets are emitted exactly as in bind mode (the caller materializes them into the volume).
    expect(out.stubs).toHaveLength(2);
  });

  it("skips missing paths in volume mode (same as bind mode)", () => {
    const out = buildRestrictionMounts(WS, STUBS, perms({ denyRead: ["gone.txt"] }), probes({}), VOLUME);
    expect(out.args).toEqual([]);
    expect(out.stubs).toEqual([]);
  });

  it("keeps the deny-read-covers-deny-edit dedupe in volume mode", () => {
    const out = buildRestrictionMounts(
      WS, STUBS,
      perms({ denyRead: ["skills"], denyEdit: ["skills"] }),
      probes({ skills: "dir" }),
      VOLUME,
    );
    expect(out.args).toEqual([
      "--mount",
      `type=volume,source=${VOL},target=/workspace/skills,volume-subpath=.agent-permissions/ws_abc/stubs/readdir/skills,readonly`,
    ]);
  });
});
