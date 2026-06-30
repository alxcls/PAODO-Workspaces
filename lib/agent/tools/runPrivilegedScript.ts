// Agent tool that runs a user-approved PRIVILEGED script as the non-root `privd` user — the only
// identity that owns (and can therefore read/write) locked and hidden files. This is the sole path
// by which the agent can cause protected files to change: it cannot edit the script (privilege
// implies lock, kernel-enforced), and it cannot self-grant privilege — only the user can, in the UI.
//
// The path must be registered privileged in the permission store; anything else is refused. The
// script is run by exact path (no shell operator parsing), so there is no way to smuggle a second
// command into the privileged identity.
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { normalizeRelpath } from "../pathUtils";
import { isPrivileged } from "../../infra/permissionStore";
import type { PrivilegedRunner } from "../interfaces";

const schema = z.object({
  path: z.string().describe("Path to the privileged script, relative to the workspace root"),
  args: z.array(z.string()).optional().describe("Arguments passed to the script"),
  runtime: z.string().optional().describe('Optional interpreter to run the script with, e.g. "python3", "node", "bash". Omit to execute the script directly (it must have a shebang and be executable).'),
});

export class RunPrivilegedScriptTool extends StructuredTool<typeof schema> {
  name = "run_privileged_script";
  description = `Run a PRIVILEGED script (one the user marked with the key icon, shown to you as [P]).
Privileged scripts run as a trusted user that CAN read hidden files and read/write locked files — the
only way to make protected files change. Use this when a task requires touching a [P], [R], or [H] path.

- path is relative to the workspace root and must already be privileged ([P]). You cannot privilege a
  script yourself — ask the user to click the key icon if it is not yet [P].
- You cannot edit a privileged script (it is locked). If it needs changes, ask the user.
- Optionally pass a runtime (python3/node/bash/…) and args.`;
  schema = schema;

  constructor(
    private readonly workspaceId: string,
    private readonly runner: PrivilegedRunner,
  ) {
    super();
  }

  protected async _call({ path: scriptPath, args = [], runtime }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(scriptPath);
    if (relpath === null) return "Error: path is outside the workspace";
    if (!isPrivileged(this.workspaceId, relpath)) {
      return `Error: ${scriptPath} is not a privileged script. Only scripts the user marked privileged ([P], the key icon) can run here. Ask the user to grant it if this is intended — you cannot privilege a script yourself.`;
    }

    const target = `/workspace/${relpath}`;
    const argv = runtime ? [runtime, target, ...args] : [target, ...args];
    const cwd = path.posix.dirname(target);
    try {
      const r = await this.runner.execAsPrivileged(argv, { cwd });
      const failed = r.code !== 0;
      const parts = [
        failed ? `Error: privileged script exited with code ${r.code}` : "",
        r.stdout.trim(),
        r.stderr.trim() ? `[stderr]: ${r.stderr.trim()}` : "",
      ].filter(Boolean);
      return parts.join("\n") || "Privileged script executed successfully with no output.";
    } catch (err: unknown) {
      return `Error: privileged script execution failed\n${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
