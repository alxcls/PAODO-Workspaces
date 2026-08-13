// apt's download cache must not outlive the install that created it.
//
// Workspace containers are now kept for the life of the workspace (see
// containerManager.persistence.test.ts), so nothing ever wipes their writable layer. The .deb
// archives apt fetches and the repository index `apt-get update` writes are pure download cache —
// re-fetched on demand, and re-fetched by this tool on every call regardless — so left alone they
// would accumulate in every workspace forever.
import { describe, it, expect } from "vitest";
import { AptInstallTool } from "./aptInstall";
import type { ExecResult, PrivilegedRunner } from "../interfaces";

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

function makeRunner(results: Partial<Record<string, ExecResult>> = {}) {
  const calls: string[][] = [];
  const runner: PrivilegedRunner = {
    exec: async () => OK,
    execAsRoot: async (cmd) => {
      calls.push(cmd);
      return results[cmd[1] ?? ""] ?? OK;
    },
  };
  return { runner, calls };
}

const cleanupRan = (calls: string[][]) =>
  calls.some((c) => c.join(" ").includes("apt-get clean") && c.join(" ").includes("/var/lib/apt/lists"));

describe("apt_install discards what it downloaded", () => {
  it("cleans up after a successful install", async () => {
    const { runner, calls } = makeRunner();
    const out = await new AptInstallTool(runner).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Installed: ffmpeg");
    expect(cleanupRan(calls)).toBe(true);
  });

  // apt-get update may already have written the index before the install failed, so the failure
  // path leaks exactly as much as the success path if it returns early.
  it("cleans up even when the install fails", async () => {
    const { runner, calls } = makeRunner({ install: { code: 100, stdout: "", stderr: "no such package" } });
    const out = await new AptInstallTool(runner).invoke({ packages: ["nosuchpkg"] });

    expect(out).toContain("Error: apt-get install failed");
    expect(cleanupRan(calls)).toBe(true);
  });

  it("cleans up even when the index refresh fails", async () => {
    const { runner, calls } = makeRunner({ update: { code: 1, stdout: "", stderr: "network unreachable" } });
    const out = await new AptInstallTool(runner).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Error: apt-get update failed");
    expect(cleanupRan(calls)).toBe(true);
  });

  // Housekeeping must never turn a working install into a reported failure.
  it("still reports success when the cleanup itself fails", async () => {
    const calls: string[][] = [];
    const runner: PrivilegedRunner = {
      exec: async () => OK,
      execAsRoot: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "/bin/sh") throw new Error("docker exec failed");
        return OK;
      },
    };
    const out = await new AptInstallTool(runner).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Installed: ffmpeg");
  });

  // The tool's whole security posture is that package names never reach a shell. The cleanup is the
  // one shelled command, so it must stay a fixed string with nothing interpolated into it.
  it("never puts a package name through the shell", async () => {
    const { runner, calls } = makeRunner();
    await new AptInstallTool(runner).invoke({ packages: ["ffmpeg"] });

    const shelled = calls.filter((c) => c[0] === "/bin/sh");
    expect(shelled).toHaveLength(1);
    expect(shelled[0].join(" ")).not.toContain("ffmpeg");
  });
});
