// Pins the policy core: that a permission store composes into exactly the mount args the ADR's
// mechanics require (deny-read file -> ro stub bind; deny-read dir -> ro stub-dir bind; deny-edit
// -> ro self-bind), and that every fail-closed rule THROWS rather than passing a path through
// read-write. The spike already proved the kernel behaviour of these mounts; this proves the app
// emits them — and refuses, never silently allows, on the ambiguous inputs that sank prior drafts.

import { describe, it, expect } from "vitest";
import {
  buildRestrictionMounts,
  PolicyError,
  EMPTY_PERMISSIONS,
  type AgentPermissions,
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

  it("FAILS CLOSED on a missing deny-read path", () => {
    expect(() => buildRestrictionMounts(WS, STUBS, perms({ denyRead: ["gone.txt"] }), probes({})))
      .toThrow(PolicyError);
  });

  it("FAILS CLOSED on a missing deny-edit path", () => {
    expect(() => buildRestrictionMounts(WS, STUBS, perms({ denyEdit: ["gone.txt"] }), probes({})))
      .toThrow(PolicyError);
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
