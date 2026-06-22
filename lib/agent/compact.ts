// Context compaction primitives, driven by the `compact_context` tool signal in the runner.
// The runner is the only owner of the live `messages` array, so all surgery happens here,
// AFTER a turn fully commits — that keeps every tool_call paired with its tool_result
// (Anthropic's hard invariant) since we only ever keep or wipe complete turns.
//
// Two primitives compose three agent-chosen levels:
//   light  — strip re-derivable tool output in place (no LLM call, no deletion)
//   medium — strip + summarize the old portion, keep recent turns verbatim
//   hard   — summarize everything into a single brief: a clean slate

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createLogger } from "../infra/logger";

const log = createLogger("compact");

export type CompactLevel = "light" | "medium" | "hard";

export const CLEARED = "[content cleared to save context]";

// Tools whose output is bulky and trivially re-derivable (re-read the file, re-run the search).
// Stripping these is the cheap win against O(n²) compounding. Deliberately excludes todo_write
// (the agent's live checklist), compact_context (carries next_step), and call_agent/list_agents.
export const STRIPPABLE_TOOLS = new Set<string>([
  "file_read",
  "glob",
  "list_directory",
  "http_get",
  "execute_command",
]);

// How many trailing messages medium tries to keep verbatim before snapping to a turn boundary.
const KEEP_RECENT = 6;

const COMPACT_PROMPT = `Summarize the conversation so far into a dense brief that will REPLACE the history above.
Capture: the overall goal, what has been done, key findings and decisions, and the current state (including any in-progress checklist/todos).
Be information-dense and concrete — names, ids, paths, numbers. Do not omit anything needed to continue. Do not attempt any tool calls; respond with the summary only.`;

// Builds a tool_call_id -> tool name map by scanning AIMessage.tool_calls, so a ToolMessage
// can be matched to the tool that produced it (ToolMessage only carries the call id).
function toolNameByCallId(messages: BaseMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m instanceof AIMessage && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.name) map.set(tc.id, tc.name);
      }
    }
  }
  return map;
}

// light: replace bulky re-derivable tool results with a placeholder, in place. No structural
// change, so no tool_call/tool_result pair can be orphaned.
export function stripToolOutputs(messages: BaseMessage[]): void {
  const names = toolNameByCallId(messages);
  for (const m of messages) {
    if (m instanceof ToolMessage && typeof m.content === "string" && m.content !== CLEARED) {
      const name = names.get(m.tool_call_id);
      if (name && STRIPPABLE_TOOLS.has(name)) m.content = CLEARED;
    }
  }
}

// One tool-less LLM turn that condenses the given history into a brief.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function summarizeHistory(model: any, history: BaseMessage[], nextStep: string): Promise<string> {
  const res = await model.invoke([...history, new HumanMessage(`${COMPACT_PROMPT}\n\nThe next step after this summary is: ${nextStep}`)]);
  const content = res?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: unknown) => (b && typeof b === "object" && "text" in b ? (b as { text: string }).text : "")).join("");
  }
  return String(content ?? "");
}

// Applies the chosen level to `messages` IN PLACE (splice preserves the array reference the
// runner and the route layer both hold). messages[0] is the SystemMessage and is always kept.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyCompaction(model: any, messages: BaseMessage[], level: CompactLevel, nextStep: string): Promise<void> {
  const before = messages.length;

  if (level === "light") {
    stripToolOutputs(messages);
    log.info({ level, before, after: messages.length }, "context compacted");
    return;
  }

  const system = messages[0];

  if (level === "hard") {
    const summary = await summarizeHistory(model, messages.slice(1), nextStep);
    const brief = new HumanMessage(`${summary}\n\nNext step: ${nextStep}`);
    messages.splice(0, messages.length, system, brief);
    log.info({ level, before, after: messages.length }, "context compacted");
    return;
  }

  // medium: summarize the head, keep a recent verbatim tail. Snap the tail boundary forward to
  // the next AIMessage so the spliced sequence is [system, Human(summary), AIMessage, …] —
  // clean user→assistant alternation, and an AIMessage's tool_calls keep their following
  // ToolMessages (which sit in the tail). Strip the kept tail too, for extra savings.
  let cut = Math.max(1, messages.length - KEEP_RECENT);
  while (cut < messages.length && !(messages[cut] instanceof AIMessage)) cut++;

  if (cut >= messages.length) {
    // No AIMessage boundary in the tail window — fall back to hard rather than risk orphaning.
    const summary = await summarizeHistory(model, messages.slice(1), nextStep);
    const brief = new HumanMessage(`${summary}\n\nNext step: ${nextStep}`);
    messages.splice(0, messages.length, system, brief);
    log.info({ level: "medium->hard", before, after: messages.length }, "context compacted");
    return;
  }

  const summary = await summarizeHistory(model, messages.slice(1, cut), nextStep);
  const tail = messages.slice(cut);
  const briefMessages = [system, new HumanMessage(summary), ...tail];
  messages.splice(0, messages.length, ...briefMessages);
  stripToolOutputs(messages);
  log.info({ level, before, after: messages.length }, "context compacted");
}
