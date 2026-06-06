import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { aptInstall } from "../../infra/aptBroker";
import { getGlobalLock } from "../../infra/permissionStore";

export function buildInstallSystemPackageTool(workspaceId: string, _workspaceDir: string) {
  return tool(
    async ({ packages }) => {
      if (await getGlobalLock(workspaceId)) {
        return "Error: workspace is globally locked — package installation is not allowed. Ask the user to unlock the workspace first.";
      }
      const result = await aptInstall(workspaceId, packages);
      if (result.code !== 0) {
        return `Error installing ${packages.join(", ")}: ${result.stderr || "unknown error"}`;
      }
      return `Installed: ${result.installed.join(", ")}`;
    },
    {
      name: "install_system_package",
      description:
        "Install one or more system packages into the workspace container via apt. " +
        "Use for system libraries/headers or interpreter/runtime packages provided by Ubuntu repositories. " +
        "If a command fails with missing .so, pkg-config, compiler, or headers, install apt packages first. " +
        "Packages must come from official Ubuntu repositories. " +
        "After the tool returns, retry the original command.",
      schema: z.object({
        packages: z
          .array(z.string())
          .min(1)
          .describe('apt package names to install, e.g. ["libopencv-dev", "ffmpeg"]'),
      }),
    }
  );
}
