// Agent-chosen context compaction. This tool is a SIGNAL only: a tool's _call receives just
// its args and returns a string — it has no handle to the conversation. The runner owns the
// `messages` array and performs the actual surgery (see lib/agent/compact.ts) AFTER the turn
// commits, where the tool_call/tool_result pair is complete (Anthropic's pairing invariant).
//
// This tool's returned ack carries `next_step`; for light/medium it survives in context as the
// last ToolMessage, so the freshly-compacted agent knows what to do next.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const schema = z.object({
  level: z
    .enum(["light", "medium", "hard"])
    .describe(
      "light = drop bulky re-derivable tool output (file reads, searches, command output), keep everything else (cheapest, use between units of work). medium = summarize older history, keep recent turns verbatim (when light isn't enough). hard = replace the whole conversation with a brief summary, a clean slate (use at a clean boundary between independent units)."
    ),
  next_step: z
    .string()
    .describe(
      "REQUIRED. The very next concrete task to do after compaction, e.g. 'map batch 16'. This is the one thing guaranteed to survive even a hard compaction."
    ),
});

export class CompactContextTool extends StructuredTool<typeof schema> {
  name = "compact_context";
  description = `Compact your own conversation to free context during a long multi-step job, then keep working. Use it between independent units of work so earlier bulky tool output does not pile up.
Pick a level:
- light: drop bulky re-derivable tool output (file reads, searches, command output), keep everything else — cheapest.
- medium: summarize older history, keep recent turns verbatim — when light isn't enough.
- hard: replace the whole conversation with a brief summary, a clean slate — at a clean boundary between independent units.
Always pass next_step: the next concrete task, guaranteed to survive even a hard compaction.`;
  schema = schema;

  protected async _call({ level, next_step }: z.infer<typeof schema>): Promise<string> {
    // No surgery here (no access to messages). The runner reads this tool call and compacts.
    return `[Context compacted: ${level}.] Next step: ${next_step}`;
  }
}
