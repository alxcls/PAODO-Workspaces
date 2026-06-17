// Drives one chat turn against the agent: POSTs the user message to the workspace chat route
// and consumes the SSE stream, folding each AgentEvent into the chat transcript. Token and
// reasoning deltas are coalesced via requestAnimationFrame so streaming stays smooth; all
// other shaping is delegated to the pure reducers in ./agentTranscript. Exposes the message
// list plus sendMessage/reset/abort and the streaming/pendingTools flags.
"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { AgentEvent } from "@/lib/agent/runner";
import { parseSseStream } from "@/lib/client/sse";
import {
  type Message,
  type TranscriptState,
  emptyTranscript,
  applyDiscreteEvent,
  upsertAssistantText,
  upsertReasoningText,
} from "../agentTranscript";

export type { Message };
export { toolLabel } from "../agentTranscript";

interface Options {
  onTurnComplete?: () => void;
}

export function useAgentStream(workspaceId: string, { onTurnComplete }: Options = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingTools, setPendingTools] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingTokenRef = useRef<string | null>(null);
  const pendingReasoningRef = useRef<string | null>(null);
  const tokenRafRef = useRef<number | null>(null);
  const reasoningRafRef = useRef<number | null>(null);

  // Single source of truth for the rendered transcript + per-turn token totals; setMessages
  // only mirrors it for rendering. Keeping both the token RAF flush and the discrete-event
  // reducer writing through here avoids the two paths drifting apart.
  const transcriptRef = useRef<TranscriptState>(emptyTranscript());
  const commit = useCallback((next: TranscriptState) => {
    transcriptRef.current = next;
    setMessages(next.messages);
  }, []);

  // Captured in a ref so sendMessage never needs to be recreated when the callback changes.
  // Updated in an effect (not during render) so the ref only ever tracks a committed render.
  const onTurnCompleteRef = useRef(onTurnComplete);
  useEffect(() => { onTurnCompleteRef.current = onTurnComplete; });

  const reset = useCallback(() => {
    transcriptRef.current = emptyTranscript();
    setMessages([]);
  }, []);

  const abort = useCallback(() => abortRef.current?.abort(), []);

  const flushToken = useCallback(() => {
    const content = pendingTokenRef.current;
    if (content === null) return;
    pendingTokenRef.current = null;
    commit({ ...transcriptRef.current, messages: upsertAssistantText(transcriptRef.current.messages, content) });
  }, [commit]);

  const flushReasoning = useCallback(() => {
    const content = pendingReasoningRef.current;
    if (content === null) return;
    pendingReasoningRef.current = null;
    commit({ ...transcriptRef.current, messages: upsertReasoningText(transcriptRef.current.messages, content) });
  }, [commit]);

  const sendMessage = useCallback(async (userMessage: string) => {
    commit({ ...transcriptRef.current, messages: [...transcriptRef.current.messages, { role: "user", content: userMessage }], totalInput: 0, totalOutput: 0 });
    setStreaming(true);

    let assistantContent = "";
    let reasoningContent = "";
    let hadToolCalls = false;
    let wasAborted = false;

    try {
      abortRef.current = new AbortController();
      const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        commit({ ...transcriptRef.current, messages: [...transcriptRef.current.messages, { role: "error", content: "Failed to reach server." }] });
        return;
      }

      for await (const event of parseSseStream<AgentEvent>(res.body)) {
        if (event.type === "token") {
          assistantContent += event.content;
          pendingTokenRef.current = assistantContent;
          if (!tokenRafRef.current) {
            tokenRafRef.current = requestAnimationFrame(() => { tokenRafRef.current = null; flushToken(); });
          }
        } else if (event.type === "reasoning") {
          reasoningContent += event.content;
          pendingReasoningRef.current = reasoningContent;
          if (!reasoningRafRef.current) {
            reasoningRafRef.current = requestAnimationFrame(() => { reasoningRafRef.current = null; flushReasoning(); });
          }
        } else if (event.type === "tool_start") {
          assistantContent = "";
          reasoningContent = "";
          hadToolCalls = true;
          setPendingTools((n) => n + 1);
          commit(applyDiscreteEvent(transcriptRef.current, event));
        } else if (event.type === "tool_result") {
          setPendingTools((n) => Math.max(0, n - 1));
          commit(applyDiscreteEvent(transcriptRef.current, event));
        } else {
          // turn_usage, done, limit_reached, error — pure folds with no hook-side bookkeeping.
          commit(applyDiscreteEvent(transcriptRef.current, event));
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        wasAborted = true;
      } else {
        commit({ ...transcriptRef.current, messages: [...transcriptRef.current.messages, { role: "error", content: "Failed to reach server." }] });
      }
    } finally {
      if (tokenRafRef.current) { cancelAnimationFrame(tokenRafRef.current); tokenRafRef.current = null; }
      if (reasoningRafRef.current) { cancelAnimationFrame(reasoningRafRef.current); reasoningRafRef.current = null; }
      flushToken();
      flushReasoning();
      abortRef.current = null;
      setStreaming(false);
      setPendingTools(0);
      if (!wasAborted && hadToolCalls && !assistantContent) {
        commit({ ...transcriptRef.current, messages: [...transcriptRef.current.messages, { role: "error", content: "Agent stopped without generating a response." }] });
      }
      onTurnCompleteRef.current?.();
    }
  }, [workspaceId, commit, flushToken, flushReasoning]);

  return { messages, streaming, pendingTools, sendMessage, reset, abort };
}
