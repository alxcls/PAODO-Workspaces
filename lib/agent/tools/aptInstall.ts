// Agent tool that installs system (apt) packages into the workspace container.
//
// The agent's shell runs as a non-root user (uid 1000) and cannot `apt-get install` directly. This
// tool is the single, auditable channel for system packages: it runs apt-get AS ROOT via
// execAsRoot (docker exec -u 0 from the app server). To keep it from becoming an arbitrary
// root shell, package names are strictly validated and passed as separate argv (no shell), so no
// shell metacharacters, paths, or local .deb installs are possible — only named packages (optionally
// pinned `name=version`) from the image's configured apt repositories.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrivilegedRunner } from "../interfaces";

// name, or name=version. Lowercase apt package-name charset only; rejects `/`, spaces, and any
// shell metacharacter, which also blocks local-file (`./foo.deb`) installs.
const PKG_RE = /^[a-z0-9][a-z0-9+._-]*(=[a-zA-Z0-9+.:~-]+)?$/;

const schema = z.object({
  packages: z.array(z.string()).describe("apt package names to install, e.g. [\"ffmpeg\", \"imagemagick\"]"),
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

  constructor(private runner: PrivilegedRunner) {
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

    const update = await this.runner.execAsRoot(["apt-get", "update"]);
    if (update.code !== 0) {
      return `Error: apt-get update failed:\n${update.stderr || update.stdout}`;
    }

    const install = await this.runner.execAsRoot([
      "apt-get", "install", "-y", "--no-install-recommends", ...packages,
    ]);
    if (install.code !== 0) {
      return `Error: apt-get install failed:\n${install.stderr || install.stdout}`;
    }
    return `Installed: ${packages.join(", ")}\n${install.stdout}`.trim();
  }
}
