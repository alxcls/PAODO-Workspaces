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
  const recorded: string[][] = [];
  const runner: PrivilegedRunner = {
    exec: async () => OK,
    execAsRoot: async (cmd) => {
      calls.push(cmd);
      return results[cmd[1] ?? ""] ?? OK;
    },
  };
  const record = (pkgs: string[]) => recorded.push(pkgs);
  return { runner, calls, record, recorded };
}

const cleanupRan = (calls: string[][]) =>
  calls.some((c) => c.join(" ").includes("apt-get clean") && c.join(" ").includes("/var/lib/apt/lists"));

describe("apt_install discards what it downloaded", () => {
  it("cleans up after a successful install", async () => {
    const { runner, calls, record } = makeRunner();
    const out = await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Installed: ffmpeg");
    expect(cleanupRan(calls)).toBe(true);
  });

  // apt-get update may already have written the index before the install failed, so the failure
  // path leaks exactly as much as the success path if it returns early.
  it("cleans up even when the install fails", async () => {
    const { runner, calls, record } = makeRunner({ install: { code: 100, stdout: "", stderr: "no such package" } });
    const out = await new AptInstallTool(runner, record).invoke({ packages: ["nosuchpkg"] });

    expect(out).toContain("Error: apt-get install failed");
    expect(cleanupRan(calls)).toBe(true);
  });

  it("cleans up even when the index refresh fails", async () => {
    const { runner, calls, record } = makeRunner({ update: { code: 1, stdout: "", stderr: "network unreachable" } });
    const out = await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Error: apt-get update failed");
    expect(cleanupRan(calls)).toBe(true);
  });

  // Housekeeping must never turn a working install into a reported failure.
  it("still reports success when the cleanup itself fails", async () => {
    const calls: string[][] = [];
    const record = () => {};
    const runner: PrivilegedRunner = {
      exec: async () => OK,
      execAsRoot: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "/bin/sh") throw new Error("docker exec failed");
        return OK;
      },
    };
    const out = await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg"] });

    expect(out).toContain("Installed: ffmpeg");
  });

  // The tool's whole security posture is that package names never reach a shell. The cleanup is the
  // one shelled command, so it must stay a fixed string with nothing interpolated into it.
  it("never puts a package name through the shell", async () => {
    const { runner, calls, record } = makeRunner();
    await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg"] });

    const shelled = calls.filter((c) => c[0] === "/bin/sh");
    expect(shelled).toHaveLength(1);
    expect(shelled[0].join(" ")).not.toContain("ffmpeg");
  });
});

// This tool is the only way a system package can enter a workspace, so what it records here is the
// complete list of what a rebuilt container has to reinstall — see aptRecipe.ts.
describe("apt_install records what a rebuilt container must reinstall", () => {
  it("records the packages it installed", async () => {
    const { runner, record, recorded } = makeRunner();
    await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg", "imagemagick"] });

    expect(recorded).toEqual([["ffmpeg", "imagemagick"]]);
  });

  // A package recorded here is replayed on every future rebuild of this container. One that failed
  // to install would fail there too — forever, and with nobody watching.
  it("records nothing when the install fails", async () => {
    const { runner, record, recorded } = makeRunner({
      install: { code: 100, stdout: "", stderr: "no such package" },
    });
    await new AptInstallTool(runner, record).invoke({ packages: ["nosuchpkg"] });

    expect(recorded).toEqual([]);
  });

  it("records nothing when the index refresh fails", async () => {
    const { runner, record, recorded } = makeRunner({
      update: { code: 1, stdout: "", stderr: "network unreachable" },
    });
    await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg"] });

    expect(recorded).toEqual([]);
  });

  // Validation runs before apt does, so a rejected name never reaches the runner — and must not
  // reach the recipe either, where it would be replayed straight into apt-get's argv.
  it("records nothing when a package name is rejected", async () => {
    const { runner, record, recorded } = makeRunner();
    const out = await new AptInstallTool(runner, record).invoke({ packages: ["ffmpeg; rm -rf /"] });

    expect(out).toContain("Error: invalid package name");
    expect(recorded).toEqual([]);
  });

  it("records nothing when asked to install no packages at all", async () => {
    const { runner, record, recorded } = makeRunner();
    await new AptInstallTool(runner, record).invoke({ packages: [] });

    expect(recorded).toEqual([]);
  });
});
