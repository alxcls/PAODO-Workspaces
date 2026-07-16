// Agent tool for rolling the workspace files back to a previous snapshot mid-run — so a bad
// attempt can be discarded and retried from a known-good state instead of stacking fixes on top.
//
// This tool is a SIGNAL only, like compact_context: a tool's _call receives just its args and
// returns a string — it has no handle to the platform versioning history, which is deliberately
// outside the agent's reach. The runner reads this tool call and performs the actual restore
// (versioning.restore → reset --hard) AFTER the turn commits, where it can't race a concurrent
// file write in the same tool batch. See lib/agent/runner.ts.
//
// Restores FILES only — it cannot undo external side effects (a sent email, a called API). The
// rollback is itself visible in history (the "(current)" marker moves to the restored snapshot).

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const SHA = /^[0-9a-fA-F]{4,40}$/;

const schema = z.object({
  sha: z
    .string()
    .describe(
      "Target snapshot, a sha from workspace_history. Always list history first, then restore the exact snapshot you chose.",
    ),
});

export class WorkspaceRestoreTool extends StructuredTool<typeof schema> {
  name = "workspace_restore";
  description = `Roll the workspace files back to a previous snapshot, then keep working — use it to recover from a wrong turn instead of piling fixes on a broken state.

First call workspace_history to see the snapshots and pick the right target, THEN restore — don't call this blind.
- Pass a sha from workspace_history → revert to that specific snapshot. The current snapshot is marked in the history overview, so use that list to pick the right restore point.

This restores FILES only: it cannot undo external side effects (a sent email, an API call already made). The rollback is recorded in history like any other change. After it, the files are back to the target state and you can retry from there.`;
  schema = schema;

  protected async _call({ sha }: z.infer<typeof schema>): Promise<string> {
    // Signal only — the runner performs the restore. We just validate the target shape and return
    // an ack; an obviously bad sha is rejected here so the agent re-reads workspace_history.
    if (!SHA.test(sha)) {
      return "Error: invalid sha — pass a sha from workspace_history.";
    }
    return `Restoring the workspace files to snapshot ${sha}. Files only — external side effects (sent emails, API calls) are not undone.`;
  }
}
