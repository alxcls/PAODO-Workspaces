"use client";
import { useState, useRef, useCallback } from "react";
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
  call_agent:      (a) => `→ ${String(a.workspace ?? "")}`,
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

function toolArgSummary(name: string, args: Record<string, unknown>): string {
  return TOOL_ARG_SUMMARY[name]?.(args) ?? "";
}

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
  const totalInputRef = useRef(0);
  const totalOutputRef = useRef(0);

  // Captured in a ref so sendMessage never needs to be recreated when the callback changes.
  const onTurnCompleteRef = useRef(onTurnComplete);
  onTurnCompleteRef.current = onTurnComplete;

  const reset = useCallback(() => setMessages([]), []);

  const abort = useCallback(() => abortRef.current?.abort(), []);

  const sendMessage = useCallback(async (userMessage: string) => {
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setStreaming(true);

    let assistantContent = "";
    let reasoningContent = "";
    let hadToolCalls = false;
    let wasAborted = false;
    totalInputRef.current = 0;
    totalOutputRef.current = 0;

    try {
      abortRef.current = new AbortController();
      const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        setMessages((prev) => [...prev, { role: "error", content: "Failed to reach server." }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as AgentEvent;

            if (event.type === "token") {
              assistantContent += event.content;
              pendingTokenRef.current = assistantContent;
              if (!tokenRafRef.current) {
                tokenRafRef.current = requestAnimationFrame(() => {
                  tokenRafRef.current = null;
                  const content = pendingTokenRef.current;
                  if (content === null) return;
                  pendingTokenRef.current = null;
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant" && !last.thinking) {
                      const next = [...prev];
                      next[next.length - 1] = { ...last, content };
                      return next;
                    }
                    return [...prev, { role: "assistant", content }];
                  });
                });
              }
            } else if (event.type === "reasoning") {
              reasoningContent += event.content;
              pendingReasoningRef.current = reasoningContent;
              if (!reasoningRafRef.current) {
                reasoningRafRef.current = requestAnimationFrame(() => {
                  reasoningRafRef.current = null;
                  const content = pendingReasoningRef.current;
                  if (content === null) return;
                  pendingReasoningRef.current = null;
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "reasoning") {
                      const next = [...prev];
                      next[next.length - 1] = { ...last, content };
                      return next;
                    }
                    return [...prev, { role: "reasoning", content }];
                  });
                });
              }
            } else if (event.type === "tool_start") {
              assistantContent = "";
              reasoningContent = "";
              hadToolCalls = true;
              setPendingTools((n) => n + 1);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const toolMsg: Message = {
                  role: "tool_start",
                  toolName: event.name,
                  toolSummary: toolArgSummary(event.name, event.args),
                  toolDone: false,
                };
                if (last?.role === "assistant" && !last.thinking) {
                  return [...prev.slice(0, -1), { ...last, thinking: true }, toolMsg];
                }
                return [...prev, toolMsg];
              });
            } else if (event.type === "tool_result") {
              setPendingTools((n) => Math.max(0, n - 1));
              const resultText = event.name === "call_agent" ? event.result : undefined;
              setMessages((prev) => {
                const next = [...prev];
                for (let j = next.length - 1; j >= 0; j--) {
                  if (next[j].role === "tool_start" && next[j].toolName === event.name && !next[j].toolDone) {
                    next[j] = { ...next[j], toolDone: true, ...(resultText ? { toolResult: resultText } : {}) };
                    break;
                  }
                }
                return next;
              });
            } else if (event.type === "turn_usage") {
              totalInputRef.current += event.inputTokens;
              totalOutputRef.current += event.outputTokens;
            } else if (event.type === "done") {
              const input = totalInputRef.current;
              const output = totalOutputRef.current;
              if (input > 0 || output > 0) {
                setMessages((prev) => {
                  const lastIdx = [...prev].reverse().findIndex((m) => m.role === "assistant" && !m.thinking);
                  if (lastIdx === -1) return prev;
                  const idx = prev.length - 1 - lastIdx;
                  const usageMsg: Message = { role: "usage", inputTokens: input, outputTokens: output };
                  return [...prev.slice(0, idx), usageMsg, ...prev.slice(idx)];
                });
              }
            } else if (event.type === "limit_reached") {
              setMessages((prev) => [...prev, { role: "limit_notice" }]);
            } else if (event.type === "error") {
              setMessages((prev) => [...prev, { role: "error", content: event.message }]);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        wasAborted = true;
      } else {
        setMessages((prev) => [...prev, { role: "error", content: "Failed to reach server." }]);
      }
    } finally {
      if (tokenRafRef.current) { cancelAnimationFrame(tokenRafRef.current); tokenRafRef.current = null; }
      if (reasoningRafRef.current) { cancelAnimationFrame(reasoningRafRef.current); reasoningRafRef.current = null; }
      if (pendingTokenRef.current !== null) {
        const content = pendingTokenRef.current;
        pendingTokenRef.current = null;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.thinking) {
            const next = [...prev];
            next[next.length - 1] = { ...last, content };
            return next;
          }
          return [...prev, { role: "assistant", content }];
        });
      }
      if (pendingReasoningRef.current !== null) {
        const content = pendingReasoningRef.current;
        pendingReasoningRef.current = null;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "reasoning") {
            const next = [...prev];
            next[next.length - 1] = { ...last, content };
            return next;
          }
          return [...prev, { role: "reasoning", content }];
        });
      }
      abortRef.current = null;
      setStreaming(false);
      setPendingTools(0);
      if (!wasAborted && hadToolCalls && !assistantContent) {
        setMessages((prev) => [...prev, { role: "error", content: "Agent stopped without generating a response." }]);
      }
      onTurnCompleteRef.current?.();
    }
  }, [workspaceId]);

  return { messages, streaming, pendingTools, sendMessage, reset, abort };
}
