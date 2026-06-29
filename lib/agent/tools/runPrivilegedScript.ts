// Agent tool that TRIGGERS a user-registered privileged script. The agent supplies only the script
// path — no command string, no arguments, no shell. The app runs it in a one-shot container WITHOUT
// the agent's restriction mounts ("privilege by location"): the script can read deny-read content and
// write deny-edit paths, while the agent that triggered it gains no such access itself.
//
// Keying is user-only: a script becomes privileged only when the user grants it the key badge in the
// file tree (the agent-permissions store). This tool refuses any path that isn't registered, so the
// agent can never escalate itself.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import { buildFilePolicy, loadPermissions, type FilePolicy } from "../../infra/docker/agentPermissionStore";
import type { IContainerManager } from "../../infra/interfaces";

const schema = z.object({
  script_path: z.string().describe("Path (relative to workspace root) of a user-registered privileged script."),
});

export class RunPrivilegedScriptTool extends StructuredTool<typeof schema> {
  name = "run_privileged_script";
  description = `Trigger a privileged script the user has registered (the "key" badge in the file tree).
A privileged script runs with full access to files that are otherwise hidden (deny-read) or locked
(deny-edit) from you — use it to perform an action on those files without seeing or altering them yourself.
- You may pass ONLY the script's path. No arguments, no command, no shell — the app runs the script as-is.
- Only paths the user has registered will run; anything else is refused.`;
  schema = schema;

  constructor(
    private workspaceId: string,
    private workspaceDir: string,
    private containers: IContainerManager,
  ) {
    super();
  }

  protected async _call({ script_path }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(script_path);
    if (relpath === null) return "Error: path is outside the workspace";

    // Probe the store first so a corrupt one fails closed here with a clear message (buildFilePolicy
    // would otherwise swallow it into allow-all — fine for the UX backstop, not for the broker).
    let policy: FilePolicy;
    try {
      loadPermissions(this.workspaceId);
      policy = buildFilePolicy(this.workspaceId);
    } catch (err) {
      return `Error: could not read workspace permissions: ${err instanceof Error ? err.message : String(err)}`;
    }

    // A script is runnable if the user made it privileged (key badge) OR hidden (deny-read). A hidden
    // script is already unreadable and implicitly locked (isDenyEdit returns true for deny-read paths),
    // so there is no extra security value in also requiring the key badge.
    if (!policy.isPrivileged(relpath) && !policy.isDenyRead(relpath)) {
      return `Error: ${script_path} is not registered for execution. Ask the user to either grant it privilege (the key badge) or hide it (the eye badge) in the file tree.`;
    }

    // Belt-and-suspenders against a hand-edited store: setPermission enforces privilege⟹lock at the
    // write path, but verify it again here at trigger time. A privileged script the agent could edit
    // is a sandbox escape (rewrite then run unrestricted), so refuse to run one that isn't locked.
    if (!policy.isDenyEdit(relpath)) {
      return `Error: ${script_path} is registered as privileged but is not locked (deny-edit), so refusing to run it. A privileged script must be lockable so you cannot rewrite it. Ask the user to lock it (the lock badge in the file tree).`;
    }

    const { code, stdout, stderr } = await this.containers.runPrivilegedScript(
      this.workspaceId, this.workspaceDir, relpath,
    );
    const failed = typeof code === "number" && code !== 0;
    const parts = [
      failed ? `Error: script exited with code ${code}` : `Script completed (exit ${code ?? 0}).`,
      stdout.trim(),
      stderr.trim() ? `[stderr]: ${stderr.trim()}` : "",
    ].filter(Boolean);
    return parts.join("\n");
  }
}
