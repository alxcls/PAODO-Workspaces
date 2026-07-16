// Serialize/deserialize the agent's LangChain message history for on-disk persistence, and
// project a message history into the client transcript shape used by the chat UI.
//
// The system prompt (a SystemMessage at index 0) is rebuilt fresh on every run from AGENTS.md
// (see chat/route.ts), so it is intentionally stripped before saving and re-prepended on load —
// persisting it would freeze a stale prompt into the conversation.
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
  type AIMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import type { Message } from "@/lib/client/agentTranscript";
import { toolArgSummary } from "@/lib/client/agentTranscript";

// Newer models return content as an array of typed blocks instead of a plain string.
// Mirror of runner.ts's helper — duplicated (not imported) to keep this module off the heavy
// runner import chain.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) return (block as { text: string }).text;
        return "";
      })
      .join("");
  }
  return "";
}

function isSystem(m: BaseMessage): boolean {
  return m._getType() === "system";
}

/** Strip the leading system prompt (if present) and serialize the rest to JSON-safe records. */
export function serializeMessages(messages: BaseMessage[]): StoredMessage[] {
  const body = messages.length > 0 && isSystem(messages[0]) ? messages.slice(1) : messages;
  return mapChatMessagesToStoredMessages(body);
}

/** Rebuild LangChain message instances from stored records. No system prompt is included. */
export function deserializeMessages(stored: StoredMessage[]): BaseMessage[] {
  return mapStoredMessagesToChatMessages(stored);
}

/**
 * Set the system prompt in place at index 0: replace an existing one, or unshift if absent.
 * Used by the run path so a freshly loaded (system-less) history gets the current prompt without
 * clobbering its first real message.
 */
export function setSystemPrompt(messages: BaseMessage[], system: BaseMessage): void {
  if (messages.length > 0 && isSystem(messages[0])) messages[0] = system;
  else messages.unshift(system);
}

/**
 * Project a saved message history into the client transcript (the same Message[] the live SSE
 * stream produces), so a reloaded conversation renders identically to one watched live. Reasoning
 * blocks are streaming-only and intentionally omitted from replay. The run-cumulative usage line,
 * stashed on the terminal AIMessage's response_metadata by the runner, IS replayed — emitted just
 * before the final assistant bubble to mirror the live stream's insertUsage placement.
 */
export function messagesToTranscript(messages: BaseMessage[]): Message[] {
  const out: Message[] = [];
  const bubbleByCallId = new Map<string, number>();

  for (const m of messages) {
    switch (m._getType()) {
      case "human":
        out.push({ role: "user", content: contentToText(m.content) });
        break;
      case "ai": {
        const text = contentToText(m.content);
        const toolCalls = (m as AIMessage).tool_calls ?? [];
        if (toolCalls.length === 0) {
          // The terminal turn carries the run-cumulative usage on response_metadata; emit it just
          // before the final assistant bubble, matching the live stream's insertUsage placement.
          const runUsage = (
            m.response_metadata as { runUsage?: { inputTokens?: number; outputTokens?: number } } | undefined
          )?.runUsage;
          if (runUsage && ((runUsage.inputTokens ?? 0) > 0 || (runUsage.outputTokens ?? 0) > 0)) {
            out.push({
              role: "usage",
              inputTokens: runUsage.inputTokens ?? 0,
              outputTokens: runUsage.outputTokens ?? 0,
            });
          }
          if (text.trim()) out.push({ role: "assistant", content: text });
        } else {
          if (text.trim()) out.push({ role: "assistant", content: text, thinking: true });
          for (const tc of toolCalls) {
            const idx =
              out.push({
                role: "tool_start",
                toolName: tc.name,
                toolSummary: toolArgSummary(tc.name, (tc.args ?? {}) as Record<string, unknown>),
                toolDone: true,
              }) - 1;
            if (tc.id) bubbleByCallId.set(tc.id, idx);
          }
        }
        break;
      }
      case "tool": {
        const tm = m as ToolMessage;
        const idx = bubbleByCallId.get(tm.tool_call_id);
        // Mirror the live stream: a call_agent bubble carries a deep-link to the callee's session,
        // not a result body. The link was stashed on the ToolMessage's additional_kwargs at run
        // time (runner.ts) so it survives reload.
        if (idx !== undefined && out[idx].toolName === "call_agent") {
          const kw = tm.additional_kwargs as
            | { calleeConversationId?: unknown; calleeWorkspaceId?: unknown; calleeWorkspaceName?: unknown }
            | undefined;
          if (typeof kw?.calleeConversationId === "string" && typeof kw?.calleeWorkspaceId === "string") {
            out[idx] = {
              ...out[idx],
              calleeConversationId: kw.calleeConversationId,
              calleeWorkspaceId: kw.calleeWorkspaceId,
              ...(typeof kw.calleeWorkspaceName === "string" ? { calleeWorkspaceName: kw.calleeWorkspaceName } : {}),
            };
          }
        }
        break;
      }
      // system messages are not rendered
    }
  }
  return out;
}
