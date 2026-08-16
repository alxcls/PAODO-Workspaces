// Context compaction, driven by the `compact_context` tool signal. Runs AFTER a turn fully commits,
// so every tool_call keeps its tool_result: levels light/medium/hard only keep or wipe whole turns.

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { contentToText } from "@/lib/transcript/content";
import { createLogger } from "../infra/logger";
import type { ModelGateway } from "./modelGateway";

const log = createLogger("compact");

export type CompactLevel = "light" | "medium" | "hard";

export const CLEARED = "[content cleared to save context]";

// Bulky and trivially re-derivable output — the cheap win against O(n²) compounding. Excludes
// todo_write (live checklist), compact_context (carries next_step), and call_agent/list_agents.
export const STRIPPABLE_TOOLS = new Set<string>(["file_read", "glob", "list_directory", "http_get", "execute_command"]);

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

// One tool-less LLM turn condensing history into a brief. It sends the whole conversation, so it is
// routinely the app's largest request — and went unmeasured until it came through the gateway.
async function summarizeHistory(model: ModelGateway, history: BaseMessage[], nextStep: string): Promise<string> {
  const { message } = await model.invoke(
    [...history, new HumanMessage(`${COMPACT_PROMPT}\n\nThe next step after this summary is: ${nextStep}`)],
    { stage: "compaction" },
  );
  return contentToText(message.content);
}

// Applies the chosen level to `messages` IN PLACE (splice preserves the array reference the
// runner and the route layer both hold). messages[0] is the SystemMessage and is always kept.
export async function applyCompaction(
  model: ModelGateway,
  messages: BaseMessage[],
  level: CompactLevel,
  nextStep: string,
): Promise<void> {
  const before = messages.length;

  if (level === "light") {
    stripToolOutputs(messages);
    log.info({ compactLevel: level, before, after: messages.length }, "context compacted");
    return;
  }

  const system = messages[0];

  if (level === "hard") {
    const summary = await summarizeHistory(model, messages.slice(1), nextStep);
    const brief = new HumanMessage(`${summary}\n\nNext step: ${nextStep}`);
    messages.splice(0, messages.length, system, brief);
    log.info({ compactLevel: level, before, after: messages.length }, "context compacted");
    return;
  }

  // medium: summarize the head, keep a verbatim tail. The boundary snaps forward to the next
  // AIMessage for clean alternation, and so its tool_calls keep the ToolMessages that follow.
  let cut = Math.max(1, messages.length - KEEP_RECENT);
  while (cut < messages.length && !(messages[cut] instanceof AIMessage)) cut++;

  if (cut >= messages.length) {
    // No AIMessage boundary in the tail window — fall back to hard rather than risk orphaning.
    const summary = await summarizeHistory(model, messages.slice(1), nextStep);
    const brief = new HumanMessage(`${summary}\n\nNext step: ${nextStep}`);
    messages.splice(0, messages.length, system, brief);
    log.info({ compactLevel: "medium->hard", before, after: messages.length }, "context compacted");
    return;
  }

  const summary = await summarizeHistory(model, messages.slice(1, cut), nextStep);
  const tail = messages.slice(cut);
  const briefMessages = [system, new HumanMessage(summary), ...tail];
  messages.splice(0, messages.length, ...briefMessages);
  stripToolOutputs(messages);
  log.info({ compactLevel: level, before, after: messages.length }, "context compacted");
}
