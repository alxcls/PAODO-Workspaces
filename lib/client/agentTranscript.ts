// Pure transcript logic for the agent chat stream: the Message shape, the tool display maps,
// and the reducers that fold AgentEvents into the rendered message list. No React, no DOM —
// useAgentStream owns the state + RAF coalescing and delegates all shaping here, which keeps
// this layer unit-testable under the plain node vitest config.
import type { AgentEvent } from "@/lib/agent/runner";
import type { CallAgentMeta } from "@/lib/agent/tools/agentCall";

export interface Message {
  role: "user" | "assistant" | "tool_start" | "error" | "limit_notice" | "reasoning" | "usage";
  content?: string;
  toolName?: string;
  // The provider's tool_call id, when it supplied one. Identifies which bubble a later
  // tool_link/tool_result belongs to when one turn opens several bubbles for the same tool.
  toolCallId?: string;
  toolSummary?: string;
  toolDone?: boolean;
  // Set only on a completed call_agent tool bubble: deep-link to the callee's persisted session.
  calleeWorkspaceId?: string;
  calleeWorkspaceName?: string;
  calleeConversationId?: string;
  thinking?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

// Running transcript: the rendered messages plus the per-turn token totals that the `done`
// event folds into an inline usage message.
export interface TranscriptState {
  messages: Message[];
  totalInput: number;
  totalOutput: number;
}

export const emptyTranscript = (): TranscriptState => ({ messages: [], totalInput: 0, totalOutput: 0 });

// Extend this map to support new tools without modifying dispatch logic (OCP).
const TOOL_LABELS: Record<string, string> = {
  file_read: "Reading file",
  file_write: "Writing file",
  file_edit: "Editing file",
  execute_command: "Running command",
  http_get: "Fetching page",
  todo_write: "Updating tasks",
  glob: "Searching files",
  list_directory: "Listing directory",
};

type ArgExtractor = (args: Record<string, unknown>) => string;
const TOOL_ARG_SUMMARY: Record<string, ArgExtractor> = {
  execute_command: (a) => String(a.command ?? ""),
  file_read: (a) => String(a.file_path ?? ""),
  file_write: (a) => String(a.file_path ?? ""),
  file_edit: (a) => String(a.file_path ?? ""),
  glob: (a) => String(a.pattern ?? ""),
  list_directory: (a) => String(a.dir_path ?? "") || ".",
  http_get: (a) => String(a.url ?? ""),
  call_agent: (a) => `→ ${String(a.workspace ?? "")}${a.action ? ` · ${String(a.action)}` : ""}`,
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

export function toolArgSummary(name: string, args: Record<string, unknown>): string {
  return TOOL_ARG_SUMMARY[name]?.(args) ?? "";
}

// Token coalescing: replace the trailing assistant bubble with the full accumulated text, or
// start a new one if the last message isn't an open assistant turn. Shared by the streaming RAF
// flush and the terminal flush in the hook's finally block — the single source of this rule.
export function upsertAssistantText(messages: Message[], content: string): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && !last.thinking) {
    const next = [...messages];
    next[next.length - 1] = { ...last, content };
    return next;
  }
  return [...messages, { role: "assistant", content }];
}

export function upsertReasoningText(messages: Message[], content: string): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "reasoning") {
    const next = [...messages];
    next[next.length - 1] = { ...last, content };
    return next;
  }
  return [...messages, { role: "reasoning", content }];
}

// Marks the current assistant turn as "thinking" (so it renders collapsed once a tool runs)
// and appends the live tool-status bubble.
function appendToolStart(messages: Message[], name: string, args: Record<string, unknown>, id?: string): Message[] {
  const last = messages[messages.length - 1];
  const toolMsg: Message = {
    role: "tool_start",
    toolName: name,
    ...(id ? { toolCallId: id } : {}),
    toolSummary: toolArgSummary(name, args),
    toolDone: false,
  };
  if (last?.role === "assistant" && !last.thinking) {
    return [...messages.slice(0, -1), { ...last, thinking: true }, toolMsg];
  }
  return [...messages, toolMsg];
}

// Locates the open bubble an event refers to. When the event carries a tool_call id, only the
// bubble opened by that same call matches — two parallel call_agent bubbles are then updated
// independently instead of both events landing on the last one. Without an id (providers that
// don't supply one) it falls back to the most recent open bubble for the tool, which is correct
// for the one-call-at-a-time case.
function findOpenToolIdx(messages: Message[], name: string, id?: string, unlinkedOnly = false): number {
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role !== "tool_start" || m.toolDone) continue;
    if (id && m.toolCallId) {
      if (m.toolCallId === id) return j;
      continue;
    }
    if (m.toolName !== name) continue;
    // Id-less fallback for a link: an already-linked bubble belongs to a different parallel
    // call, so keep looking rather than overwriting its link.
    if (unlinkedOnly && m.calleeConversationId) continue;
    return j;
  }
  return -1;
}

const linkFields = (link: CallAgentMeta) => ({
  calleeWorkspaceId: link.workspaceId,
  calleeWorkspaceName: link.workspaceName,
  calleeConversationId: link.conversationId,
});

// Flips the tool bubble this result belongs to to done, attaching the callee session link
// if one was provided (call_agent only).
function markToolDone(messages: Message[], name: string, id?: string, link?: CallAgentMeta): Message[] {
  const idx = findOpenToolIdx(messages, name, id);
  if (idx === -1) return messages;
  const next = [...messages];
  next[idx] = { ...next[idx], toolDone: true, ...(link ? linkFields(link) : {}) };
  return next;
}

// Attaches the callee session deep-link to the still-open bubble for this call (call_agent),
// without flipping it to done — the spinner keeps running while the callee works, but the
// "View session" link is already clickable. No-op if the bubble already carries the link.
function attachToolLink(messages: Message[], name: string, link: CallAgentMeta, id?: string): Message[] {
  const idx = findOpenToolIdx(messages, name, id, true);
  if (idx === -1 || messages[idx].calleeConversationId === link.conversationId) return messages;
  const next = [...messages];
  next[idx] = { ...next[idx], ...linkFields(link) };
  return next;
}

// Flips every still-open tool bubble to done. Used when a turn ends without a tool_result for
// each one — e.g. the user hit escape mid-command, so the client aborts the stream and never
// receives the matching tool_result — so no tool spinner is left running forever. Idempotent:
// returns the same array when nothing is open.
export function markAllToolsDone(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === "tool_start" && !m.toolDone)) return messages;
  return messages.map((m) => (m.role === "tool_start" && !m.toolDone ? { ...m, toolDone: true } : m));
}

// Inserts the usage line just before the last completed assistant message (no-op if there
// isn't one). Caller only invokes this when there are tokens to report.
function insertUsage(messages: Message[], inputTokens: number, outputTokens: number): Message[] {
  const lastIdx = [...messages].reverse().findIndex((m) => m.role === "assistant" && !m.thinking);
  if (lastIdx === -1) return messages;
  const idx = messages.length - 1 - lastIdx;
  const usageMsg: Message = { role: "usage", inputTokens, outputTokens };
  return [...messages.slice(0, idx), usageMsg, ...messages.slice(idx)];
}

// Pure reducer for the non-streaming events (tokens/reasoning are coalesced in the hook).
// Unrecognized events leave the state untouched.
export function applyDiscreteEvent(state: TranscriptState, event: AgentEvent): TranscriptState {
  switch (event.type) {
    case "tool_start":
      return { ...state, messages: appendToolStart(state.messages, event.name, event.args, event.id) };
    case "tool_link":
      return { ...state, messages: attachToolLink(state.messages, event.name, event.meta, event.id) };
    case "tool_result":
      return {
        ...state,
        messages: markToolDone(
          state.messages,
          event.name,
          event.id,
          event.name === "call_agent" ? event.meta : undefined,
        ),
      };
    case "turn_usage":
      return {
        ...state,
        totalInput: state.totalInput + event.inputTokens,
        totalOutput: state.totalOutput + event.outputTokens,
      };
    case "done":
      return state.totalInput > 0 || state.totalOutput > 0
        ? { ...state, messages: insertUsage(state.messages, state.totalInput, state.totalOutput) }
        : state;
    case "limit_reached":
      return { ...state, messages: [...state.messages, { role: "limit_notice" }] };
    case "error":
      return { ...state, messages: [...state.messages, { role: "error", content: event.message }] };
    default:
      return state;
  }
}
