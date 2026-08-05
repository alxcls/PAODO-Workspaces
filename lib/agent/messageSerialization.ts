// Serialize/deserialize the agent's LangChain message history for durable persistence, and
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
import type { Message } from "@/lib/transcript/message";
import { toolArgSummary } from "@/lib/transcript/toolDisplay";
import { contentToText } from "@/lib/transcript/content";

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
 * Project saved replay state into the client transcript. The execution ledger aggregates a
 * session's model turns onto its final visible output and keys that total by the stable id on the
 * corresponding AIMessage; the conversation never owns a second copy of those measurements.
 */
export function messagesToTranscript(
  messages: BaseMessage[],
  outputUsage: ReadonlyMap<
    string,
    { inputTokensTotal: number; inputTokensCacheRead: number; outputTokensTotal: number }
  > = new Map(),
): Message[] {
  const out: Message[] = [];
  const bubbleByCallId = new Map<string, number>();

  const appendUsage = (message: AIMessage) => {
    const metadata = message.response_metadata as { executionTurnId?: unknown } | undefined;
    const executionTurnId = typeof metadata?.executionTurnId === "string" ? metadata.executionTurnId : undefined;
    const usage = executionTurnId ? outputUsage.get(executionTurnId) : undefined;
    if (!usage || (usage.inputTokensTotal === 0 && usage.outputTokensTotal === 0)) return;
    out.push({
      role: "usage",
      inputTokensTotal: usage.inputTokensTotal,
      inputTokensCacheRead: usage.inputTokensCacheRead,
      outputTokensTotal: usage.outputTokensTotal,
    });
  };

  for (const m of messages) {
    switch (m._getType()) {
      case "human":
        out.push({ role: "user", content: contentToText(m.content) });
        break;
      case "ai": {
        const ai = m as AIMessage;
        const text = contentToText(ai.content);
        const toolCalls = ai.tool_calls ?? [];
        // Match the live transcript: usage introduces the model output or tool action it measures.
        appendUsage(ai);
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
