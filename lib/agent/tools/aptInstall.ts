// Agent tool that installs system (apt) packages into the workspace container.
//
// The agent's shell runs as a non-root user (uid 1000) and cannot `apt-get install` directly. This
// tool is the single, auditable channel for system packages: it runs apt-get AS ROOT via
// execAsRoot (docker exec -u 0 from the app server). To keep it from becoming an arbitrary
// root shell, package names are strictly validated and passed as separate argv, so no shell
// metacharacters, paths, or local .deb installs are possible — only named packages (optionally
// pinned `name=version`) from the image's configured apt repositories. The one command here that
// does go through a shell (discardAptDownloads) is a fixed string with nothing interpolated into it.
//
// Being that single channel is also what makes the install recoverable: every system package a
// workspace has passes through here, so recording them on success yields an exact recipe to replay
// into a rebuilt container — see aptRecipe.ts for why the packages themselves cannot be kept.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrivilegedRunner } from "../interfaces";

// name, or name=version. Lowercase apt package-name charset only; rejects `/`, spaces, and any
// shell metacharacter, which also blocks local-file (`./foo.deb`) installs.
const PKG_RE = /^[a-z0-9][a-z0-9+._-]*(=[a-zA-Z0-9+.:~-]+)?$/;

const schema = z.object({
  packages: z.array(z.string()).describe('apt package names to install, e.g. ["ffmpeg", "imagemagick"]'),
});

export class AptInstallTool extends StructuredTool<typeof schema> {
  name = "apt_install";
  description = `Install system packages (Debian/Ubuntu apt) into the workspace container.
Use this when a task needs a system-level tool or library that is not already installed and that
cannot be provided by npm/pip (e.g. ffmpeg, imagemagick, poppler-utils, a compiler toolchain extra).
The regular shell (execute_command) runs as a non-root user and CANNOT run apt-get — use this tool instead.
Provide bare package names (optionally pinned as name=version). Paths, URLs, and local .deb files are not allowed.
Node version managers (nvm) and Python (pyenv) and language package managers (npm, pip) still work from execute_command — only system packages go through this tool.`;
  schema = schema;

  /**
   * `record` persists what was installed so a rebuilt container can get it back (see aptRecipe.ts).
   * Injected rather than imported so this tool stays free of the filesystem, and so the recording
   * and the install can never disagree about which workspace they belong to.
   */
  constructor(
    private runner: PrivilegedRunner,
    private record: (packages: string[]) => void,
  ) {
    super();
  }

  protected async _call({ packages }: z.infer<typeof schema>): Promise<string> {
    if (!Array.isArray(packages) || packages.length === 0) {
      return "Error: provide one or more package names to install.";
    }
    const invalid = packages.filter((p) => !PKG_RE.test(p));
    if (invalid.length > 0) {
      return `Error: invalid package name(s): ${invalid.join(", ")}. Only apt package names (optionally name=version) are allowed.`;
    }

    try {
      const update = await this.runner.execAsRoot(["apt-get", "update"]);
      if (update.code !== 0) {
        return `Error: apt-get update failed:\n${update.stderr || update.stdout}`;
      }

      const install = await this.runner.execAsRoot([
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        ...packages,
      ]);
      if (install.code !== 0) {
        return `Error: apt-get install failed:\n${install.stderr || install.stdout}`;
      }
      // Only on success: a package that failed to install must not be replayed into every future
      // rebuild of this container, where it would fail again.
      this.record(packages);
      return `Installed: ${packages.join(", ")}\n${install.stdout}`.trim();
    } finally {
      await this.discardAptDownloads();
    }
  }

  /**
   * Delete what apt downloaded, keeping what it installed.
   *
   * apt leaves two things behind: the .deb archives it fetched (already unpacked into the
   * filesystem — these are the shipping boxes, not the packages) and the repository index that
   * `apt-get update` writes. Both are pure download cache, and both are re-fetched on demand: this
   * tool runs `apt-get update` on every call, so the index is rebuilt each time regardless and
   * keeping it between calls buys nothing.
   *
   * The image clears these after its own installs (see Dockerfile.workspace), but until now nothing
   * did at runtime. That did not matter while containers were periodically recreated — the writable
   * layer went with them. Containers are now kept for the life of the workspace, so this junk would
   * otherwise accumulate forever. Deleting it genuinely reclaims the space: these files are created
   * at runtime in the container's writable layer, not inherited from the image.
   *
   * Runs in a `finally` so a FAILED install cleans up too — apt-get update may well have succeeded
   * and written the index before the install failed. Best-effort by design: this is housekeeping,
   * and it must never turn a successful install into a reported failure.
   */
  private async discardAptDownloads(): Promise<void> {
    try {
      await this.runner.execAsRoot(["/bin/sh", "-c", "apt-get clean; rm -rf /var/lib/apt/lists/*"]);
    } catch {
      // Ignore: the packages are installed and usable either way.
    }
  }
}
