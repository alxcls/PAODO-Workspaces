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
 * blocks and per-turn usage lines are streaming-only and intentionally omitted from replay.
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
        // Mirror the live stream, which only surfaces a result body for call_agent.
        if (idx !== undefined && out[idx].toolName === "call_agent") {
          out[idx] = { ...out[idx], toolResult: contentToText(tm.content) };
        }
        break;
      }
      // system messages are not rendered
    }
  }
  return out;
}
