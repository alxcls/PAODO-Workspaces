// Drives the chat transcript for one conversation against the agent. Sending a message and
// re-attaching to an already-running agent share one SSE-consuming core: each AgentEvent is folded
// into the transcript, with token/reasoning deltas coalesced via requestAnimationFrame for smooth
// streaming. All transcript shaping is delegated to the pure reducers in ./agentTranscript.
//
// Because the run is owned by the server (not this request), closing/switching only detaches this
// viewer — the agent keeps running. hydrate() loads a conversation's saved history; attachLive()
// reconnects to its in-flight run and watches it continue; stop() ends the run for everyone.
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
  markAllToolsDone,
} from "../agentTranscript";

export type { Message };
export { toolLabel } from "../agentTranscript";

interface Options {
  onTurnComplete?: () => void;
}

export function useAgentStream(workspaceId: string, conversationId: string | null, { onTurnComplete }: Options = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingTools, setPendingTools] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingTokenRef = useRef<string | null>(null);
  const pendingReasoningRef = useRef<string | null>(null);
  const tokenRafRef = useRef<number | null>(null);
  const reasoningRafRef = useRef<number | null>(null);

  // Single source of truth for the rendered transcript + per-turn token totals; setMessages
  // only mirrors it for rendering.
  const transcriptRef = useRef<TranscriptState>(emptyTranscript());
  const commit = useCallback((next: TranscriptState) => {
    transcriptRef.current = next;
    setMessages(next.messages);
  }, []);

  const onTurnCompleteRef = useRef(onTurnComplete);
  useEffect(() => {
    onTurnCompleteRef.current = onTurnComplete;
  });

  // Replace the whole transcript with a loaded conversation's saved history.
  const hydrate = useCallback(
    (loaded: Message[]) => {
      commit({ messages: loaded, totalInput: 0, totalOutput: 0 });
    },
    [commit],
  );

  const reset = useCallback(() => {
    commit(emptyTranscript());
  }, [commit]);

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

  // Shared SSE pump for both send and attach. `userBubble`, when given, is appended before the
  // stream opens (the user's own message echo).
  const consume = useCallback(
    async (body: object, userBubble?: string) => {
      if (userBubble !== undefined) {
        commit({
          ...transcriptRef.current,
          messages: [...transcriptRef.current.messages, { role: "user", content: userBubble }],
          totalInput: 0,
          totalOutput: 0,
        });
      }
      setStreaming(true);

      let assistantContent = "";
      let reasoningContent = "";
      let wasAborted = false;

      try {
        abortRef.current = new AbortController();
        const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          if (res.status !== 409) {
            commit({
              ...transcriptRef.current,
              messages: [...transcriptRef.current.messages, { role: "error", content: "Failed to reach server." }],
            });
          }
          return;
        }

        for await (const event of parseSseStream<AgentEvent>(res.body)) {
          if (event.type === "token") {
            assistantContent += event.content;
            pendingTokenRef.current = assistantContent;
            if (!tokenRafRef.current) {
              tokenRafRef.current = requestAnimationFrame(() => {
                tokenRafRef.current = null;
                flushToken();
              });
            }
          } else if (event.type === "reasoning") {
            reasoningContent += event.content;
            pendingReasoningRef.current = reasoningContent;
            if (!reasoningRafRef.current) {
              reasoningRafRef.current = requestAnimationFrame(() => {
                reasoningRafRef.current = null;
                flushReasoning();
              });
            }
          } else if (event.type === "tool_start") {
            assistantContent = "";
            reasoningContent = "";
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
          commit({
            ...transcriptRef.current,
            messages: [...transcriptRef.current.messages, { role: "error", content: "Failed to reach server." }],
          });
        }
      } finally {
        if (tokenRafRef.current) {
          cancelAnimationFrame(tokenRafRef.current);
          tokenRafRef.current = null;
        }
        if (reasoningRafRef.current) {
          cancelAnimationFrame(reasoningRafRef.current);
          reasoningRafRef.current = null;
        }
        flushToken();
        flushReasoning();
        // Finalize any tool row still spinning — on detach the stream is torn down before its
        // tool_result arrives, so without this a tool bubble's spinner would run forever.
        commit({ ...transcriptRef.current, messages: markAllToolsDone(transcriptRef.current.messages) });
        abortRef.current = null;
        setStreaming(false);
        setPendingTools(0);
        if (!wasAborted) onTurnCompleteRef.current?.();
      }
    },
    [workspaceId, commit, flushToken, flushReasoning],
  );

  const sendMessage = useCallback(
    async (userMessage: string) => {
      if (!conversationId) return;
      await consume({ message: userMessage, conversationId }, userMessage);
    },
    [conversationId, consume],
  );

  // Reconnect to a conversation's in-flight run. `userInput` (the message that started it) is
  // echoed as the user bubble since the saved history does not yet include this run.
  const attachLive = useCallback(
    async (userInput?: string | null) => {
      if (!conversationId) return;
      await consume({ conversationId }, userInput ?? undefined);
    },
    [conversationId, consume],
  );

  // Detach this viewer (stop reading the stream); the server-side run is unaffected.
  const detach = useCallback(() => abortRef.current?.abort(), []);

  // Stop the run for everyone. The server emits `done` and the stream closes naturally.
  const stop = useCallback(async () => {
    if (!conversationId) return;
    try {
      await fetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/stop`, { method: "POST" });
    } catch {
      // best-effort; the run will still end on its own terms
    }
  }, [workspaceId, conversationId]);

  return { messages, streaming, pendingTools, sendMessage, attachLive, hydrate, reset, detach, stop };
}
