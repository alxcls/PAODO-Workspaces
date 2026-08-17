// Drives the chat transcript for one conversation against the agent. Sending a message and
// re-attaching to an already-running agent share one SSE-consuming core: each AgentEvent is folded
// into the transcript, with token/reasoning deltas coalesced onto a fixed repaint interval.
// All transcript shaping is delegated to the pure reducers in ./agentTranscript.
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
  appendDisconnected,
  clearDisconnected,
  emptyLoopTokenUsage,
  foldTurnUsageForChat,
} from "../agentTranscript";

export type { Message };
export { toolLabel } from "@/lib/transcript/toolDisplay";

interface Options {
  onTurnComplete?: () => void;
}

// How one pass over the SSE stream ended, which decides whether reconnecting is the right move:
//   ok       — the stream closed normally after `done`
//   aborted  — this viewer detached on purpose (tab switch / conversation change); not a failure
//   dropped  — the connection died mid-stream. The run is server-owned and almost certainly still
//              going, so this is recoverable and must not be reported as a failed turn.
//   failed   — the request itself never landed; nothing is streaming and there is nothing to resume
type StreamOutcome = "ok" | "aborted" | "dropped" | "failed";

// Pause before each reconnect attempt. A dropped viewer is usually a blip (proxy idle-drop, wifi
// switch, laptop wake), so back off briefly and rebuild rather than failing the turn outright.
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Streaming deltas repaint on this interval rather than every animation frame. A reasoning stretch
// is one growing message, so each repaint re-renders all of it; ten a second still reads as smooth.
const STREAM_FLUSH_MS = 100;

/** A rate-limit wait in progress, surfaced in place of the thinking bubble. */
export interface PacedState {
  provider: string;
  model: string;
  waitMs: number;
  queueDepth: number;
  /** When the wait is expected to end, so the row can count down instead of showing a frozen number. */
  endsAt: number;
}

interface ConversationSnapshot {
  transcript: Message[];
  running: boolean;
  userInput: string | null;
}

export function useAgentStream(workspaceId: string, conversationId: string | null, { onTurnComplete }: Options = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  // True only while backing off between reconnect attempts. Folded into the exposed `streaming` so
  // the composer stays disabled during the gap: the run is still going server-side, and a message
  // sent into that window would only earn a 409 and strand the user's bubble.
  const [reconnecting, setReconnecting] = useState(false);
  const [pendingTools, setPendingTools] = useState(0);
  // Why the run has gone quiet, when it has. Transient state rather than a transcript entry: a
  // 30-turn run on a throttled model would otherwise leave 30 permanent notices behind it.
  const [paced, setPaced] = useState<PacedState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by detach() so an in-flight reconnect loop can tell that the viewer moved on (tab
  // switch, conversation change) and stop rebuilding a transcript nobody is looking at.
  const genRef = useRef(0);
  const pendingTokenRef = useRef<string | null>(null);
  const pendingReasoningRef = useRef<string | null>(null);
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasoningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A paced notice describes admission, not the provider's subsequent inference time. Once its
  // deadline passes, return to the ordinary thinking indicator even if Mistral has not emitted its
  // first visible token yet. A newer notice replaces the object and therefore owns a fresh timer.
  useEffect(() => {
    if (!paced) return;
    const timer = setTimeout(
      () => setPaced((current) => (current === paced ? null : current)),
      Math.max(0, paced.endsAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [paced]);

  // Single source of truth for the rendered transcript; setMessages only mirrors it for rendering.
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
      commit({ messages: loaded });
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

  // One pending repaint at a time. A direct flush (tool_start, turn_usage) empties the buffer, so a
  // timer that fires afterwards is a harmless no-op.
  const scheduleTokenFlush = useCallback(() => {
    if (tokenTimerRef.current) return;
    tokenTimerRef.current = setTimeout(() => {
      tokenTimerRef.current = null;
      flushToken();
    }, STREAM_FLUSH_MS);
  }, [flushToken]);

  const scheduleReasoningFlush = useCallback(() => {
    if (reasoningTimerRef.current) return;
    reasoningTimerRef.current = setTimeout(() => {
      reasoningTimerRef.current = null;
      flushReasoning();
    }, STREAM_FLUSH_MS);
  }, [flushReasoning]);

  // Shared SSE pump for both send and attach. `userBubble`, when given, is appended before the
  // stream opens (the user's own message echo).
  const consume = useCallback(
    async (body: object, userBubble?: string): Promise<StreamOutcome> => {
      if (userBubble !== undefined) {
        commit({
          ...transcriptRef.current,
          messages: [...transcriptRef.current.messages, { role: "user", content: userBubble }],
        });
      }
      // Exact usage is known only when a model turn ends. Remember where that turn starts so its
      // completed badge can be inserted above the reasoning/text/tool group it produced.
      let turnStartIndex = transcriptRef.current.messages.length;
      let loopUsage = emptyLoopTokenUsage();
      setStreaming(true);

      let assistantContent = "";
      let reasoningContent = "";
      let wasAborted = false;
      let outcome: StreamOutcome = "ok";

      try {
        abortRef.current = new AbortController();
        const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          // 409 means a run is already in progress for this conversation — not an error worth
          // showing. Capacity is an expected refusal: show its precise message in the chatbot.
          if (res.status === 409) {
            outcome = "ok";
          } else if (res.status === 503) {
            let message: string | null = null;
            try {
              const body = (await res.json()) as { code?: string; error?: string };
              if (body.code === "CAPACITY_REACHED") {
                message =
                  body.error ??
                  "Execution capacity reached. This request was not started; try again when another run finishes.";
              }
            } catch {
              // An intermediary may have replaced the JSON response; treat that as unreachable.
            }
            if (message) {
              commit({
                ...transcriptRef.current,
                messages: [...transcriptRef.current.messages, { role: "error", content: message }],
              });
              outcome = "ok";
            } else {
              outcome = "failed";
            }
          } else {
            // The request never landed, so there is nothing to resume.
            outcome = "failed";
          }
          return outcome;
        }

        for await (const event of parseSseStream<AgentEvent>(res.body)) {
          if (event.type === "token") {
            assistantContent += event.content;
            setPaced(null);
            pendingTokenRef.current = assistantContent;
            scheduleTokenFlush();
          } else if (event.type === "reasoning") {
            reasoningContent += event.content;
            // Mistral often reasons before emitting prose or a tool call. That is real provider
            // activity, so a completed rate-limit countdown must not remain on screen over it.
            setPaced(null);
            pendingReasoningRef.current = reasoningContent;
            scheduleReasoningFlush();
          } else if (event.type === "paced") {
            // Never committed to the transcript — it describes right now, and the next real event
            // means the wait is over.
            setPaced({
              provider: event.provider,
              model: event.model,
              waitMs: event.waitMs,
              queueDepth: event.queueDepth,
              endsAt: Date.now() + event.waitMs,
            });
          } else if (event.type === "tool_start") {
            // Network events can beat the next scheduled repaint. Commit the model's preamble before
            // adding its tool row so the completed usage badge can precede the whole group.
            flushToken();
            flushReasoning();
            assistantContent = "";
            reasoningContent = "";
            setPaced(null);
            setPendingTools((n) => n + 1);
            commit(applyDiscreteEvent(transcriptRef.current, event));
          } else if (event.type === "tool_result") {
            setPendingTools((n) => Math.max(0, n - 1));
            commit(applyDiscreteEvent(transcriptRef.current, event));
          } else if (event.type === "turn_usage") {
            flushToken();
            flushReasoning();
            const folded = foldTurnUsageForChat(loopUsage, event);
            loopUsage = folded.totals;
            // Tool-selection turns remain visible in the execution dashboard, but chat presents
            // one run total attached only to the final human-readable assistant output.
            if (folded.displayEvent) {
              commit(applyDiscreteEvent(transcriptRef.current, folded.displayEvent, turnStartIndex));
            }
            turnStartIndex = transcriptRef.current.messages.length;
          } else if (event.type === "limit_reached") {
            commit(applyDiscreteEvent(transcriptRef.current, event));
            turnStartIndex = transcriptRef.current.messages.length;
          } else {
            // done and error — pure folds with no hook-side bookkeeping.
            commit(applyDiscreteEvent(transcriptRef.current, event));
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          wasAborted = true;
          outcome = "aborted";
        } else {
          // The feed died, not the run. Leave the transcript untouched and let the caller try to
          // rebuild it — reporting a failure here would be wrong for a run that is still going.
          outcome = "dropped";
        }
      } finally {
        if (tokenTimerRef.current) {
          clearTimeout(tokenTimerRef.current);
          tokenTimerRef.current = null;
        }
        if (reasoningTimerRef.current) {
          clearTimeout(reasoningTimerRef.current);
          reasoningTimerRef.current = null;
        }
        flushToken();
        flushReasoning();
        // Finalize any tool row still spinning — on detach the stream is torn down before its
        // tool_result arrives, so without this a tool bubble's spinner would run forever.
        commit({ ...transcriptRef.current, messages: markAllToolsDone(transcriptRef.current.messages) });
        abortRef.current = null;
        setStreaming(false);
        setPendingTools(0);
        setPaced(null);
        if (!wasAborted) onTurnCompleteRef.current?.();
      }
      return outcome;
    },
    [workspaceId, commit, flushToken, flushReasoning, scheduleTokenFlush, scheduleReasoningFlush],
  );

  // The conversation's saved history plus whether a run is still in flight.
  const fetchSnapshot = useCallback(async (): Promise<ConversationSnapshot | null> => {
    if (!conversationId) return null;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}`);
      if (!res.ok) return null;
      return (await res.json()) as ConversationSnapshot;
    } catch {
      return null; // still unreachable; the caller decides whether to try again
    }
  }, [workspaceId, conversationId]);

  // Render a conversation and, if its run is still going, watch it live. This exact order is what
  // makes reconnecting safe: hydrate() replaces the transcript with the server's saved history
  // (which, mid-run, is the history from *before* the run), so the broker's replay of everything
  // since the run started rebuilds the live portion instead of duplicating what is already on
  // screen. Used for both the initial load and every reconnect.
  const openSnapshot = useCallback(
    async (snapshot: ConversationSnapshot): Promise<StreamOutcome> => {
      hydrate(snapshot.transcript);
      if (!snapshot.running) return "ok";
      return consume({ conversationId }, snapshot.userInput ?? undefined);
    },
    [hydrate, consume, conversationId],
  );

  // Drive one stream to completion, rebuilding through a dropped connection rather than reporting
  // a failure the run never had. Only a genuinely unreachable server, after every attempt, surfaces
  // as an error.
  const runWithRecovery = useCallback(
    async (body: object, userBubble?: string) => {
      const gen = genRef.current;
      let outcome = await consume(body, userBubble);

      for (const delay of RECONNECT_DELAYS_MS) {
        if (outcome !== "dropped" || genRef.current !== gen) break;
        commit({ ...transcriptRef.current, messages: appendDisconnected(transcriptRef.current.messages) });
        setReconnecting(true);
        try {
          await sleep(delay);
          if (genRef.current !== gen) return;
          const snapshot = await fetchSnapshot();
          if (genRef.current !== gen) return;
          if (!snapshot) continue; // server still unreachable — keep the notice up and retry
          outcome = await openSnapshot(snapshot);
        } finally {
          setReconnecting(false);
        }
      }

      if (genRef.current !== gen) return;
      if (outcome === "dropped" || outcome === "failed") {
        commit({
          ...transcriptRef.current,
          messages: [
            ...clearDisconnected(transcriptRef.current.messages),
            { role: "error", content: "Failed to reach server." },
          ],
        });
      }
    },
    [consume, commit, fetchSnapshot, openSnapshot],
  );

  const sendMessage = useCallback(
    async (userMessage: string) => {
      if (!conversationId) return;
      await runWithRecovery({ message: userMessage, conversationId }, userMessage);
    },
    [conversationId, runWithRecovery],
  );

  // Reconnect to a conversation's in-flight run. `userInput` (the message that started it) is
  // echoed as the user bubble since the saved history does not yet include this run.
  const attachLive = useCallback(
    async (userInput?: string | null) => {
      if (!conversationId) return;
      await runWithRecovery({ conversationId }, userInput ?? undefined);
    },
    [conversationId, runWithRecovery],
  );

  // Initial load of a conversation: render its saved history, then watch any in-flight run — with
  // the same drop recovery as every other stream.
  const loadConversation = useCallback(async () => {
    const gen = genRef.current;
    const snapshot = await fetchSnapshot();
    // The viewer may have switched conversations while this was in flight; hydrating now would
    // paint the old conversation's history into the new one.
    if (!snapshot || genRef.current !== gen) return;
    hydrate(snapshot.transcript);
    if (snapshot.running) await runWithRecovery({ conversationId }, snapshot.userInput ?? undefined);
  }, [fetchSnapshot, hydrate, runWithRecovery, conversationId]);

  // Detach this viewer (stop reading the stream); the server-side run is unaffected. Bumping the
  // generation also cancels any reconnect loop that is mid-backoff.
  const detach = useCallback(() => {
    genRef.current++;
    abortRef.current?.abort();
  }, []);

  // Stop the run for everyone. The server emits `done` and the stream closes naturally.
  const stop = useCallback(async () => {
    if (!conversationId) return;
    try {
      await fetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/stop`, { method: "POST" });
    } catch {
      // best-effort; the run will still end on its own terms
    }
  }, [workspaceId, conversationId]);

  return {
    messages,
    streaming: streaming || reconnecting,
    pendingTools,
    paced,
    sendMessage,
    attachLive,
    loadConversation,
    hydrate,
    reset,
    detach,
    stop,
  };
}
