// Pure transcript logic for the agent chat stream: the Message shape, the tool display maps,
// and the reducers that fold AgentEvents into the rendered message list. No React, no DOM —
// useAgentStream owns the state + RAF coalescing and delegates all shaping here, which keeps
// this layer unit-testable under the plain node vitest config.
import type { AgentEvent } from "@/lib/agent/runner";

export interface Message {
  role: "user" | "assistant" | "tool_start" | "error" | "limit_notice" | "reasoning" | "usage";
  content?: string;
  toolName?: string;
  toolSummary?: string;
  toolDone?: boolean;
  toolResult?: string;
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
  file_read:       "Reading file",
  file_write:      "Writing file",
  file_edit:       "Editing file",
  execute_command: "Running command",
  http_get:        "Fetching page",
  todo_write:      "Updating tasks",
  glob:            "Searching files",
  list_directory:  "Listing directory",
};

type ArgExtractor = (args: Record<string, unknown>) => string;
const TOOL_ARG_SUMMARY: Record<string, ArgExtractor> = {
  execute_command: (a) => String(a.command ?? ""),
  file_read:       (a) => String(a.file_path ?? ""),
  file_write:      (a) => String(a.file_path ?? ""),
  file_edit:       (a) => String(a.file_path ?? ""),
  glob:            (a) => String(a.pattern ?? ""),
  list_directory:  (a) => String(a.dir_path ?? "") || ".",
  http_get:        (a) => String(a.url ?? ""),
  call_agent:      (a) => `→ ${String(a.workspace ?? "")}${a.action ? ` · ${String(a.action)}` : ""}`,
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
function appendToolStart(messages: Message[], name: string, args: Record<string, unknown>): Message[] {
  const last = messages[messages.length - 1];
  const toolMsg: Message = { role: "tool_start", toolName: name, toolSummary: toolArgSummary(name, args), toolDone: false };
  if (last?.role === "assistant" && !last.thinking) {
    return [...messages.slice(0, -1), { ...last, thinking: true }, toolMsg];
  }
  return [...messages, toolMsg];
}

// Flips the most recent open tool bubble for `name` to done, attaching its result if provided.
function markToolDone(messages: Message[], name: string, result?: string): Message[] {
  const next = [...messages];
  for (let j = next.length - 1; j >= 0; j--) {
    if (next[j].role === "tool_start" && next[j].toolName === name && !next[j].toolDone) {
      next[j] = { ...next[j], toolDone: true, ...(result ? { toolResult: result } : {}) };
      break;
    }
  }
  return next;
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
      return { ...state, messages: appendToolStart(state.messages, event.name, event.args) };
    case "tool_result":
      return {
        ...state,
        messages: markToolDone(state.messages, event.name, event.name === "call_agent" ? event.result : undefined),
      };
    case "turn_usage":
      return { ...state, totalInput: state.totalInput + event.inputTokens, totalOutput: state.totalOutput + event.outputTokens };
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
