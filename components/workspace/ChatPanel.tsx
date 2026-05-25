// Chat panel — renders the message thread and input bar for agent interaction.
"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const mdComponents: Components = {
  table: ({ node: _n, ...props }) => (
    <div className="table-wrap"><table {...props} /></div>
  ),
};
import type { AgentEvent } from "@/lib/agent/runner";

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

interface Message {
  role: "user" | "assistant" | "tool_start" | "error" | "limit_notice";
  content?: string;
  toolName?: string;
  toolSummary?: string;
  toolDone?: boolean;
  toolResult?: string;
}

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

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

function toolArgSummary(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => String(args[k] ?? "");
  switch (name) {
    case "execute_command": return s("command");
    case "file_read":       return s("file_path");
    case "file_write":
    case "file_edit":       return s("file_path");
    case "glob":            return s("pattern");
    case "list_directory":  return s("dir_path") || ".";
    case "http_get":        return s("url");
    case "call_agent":      return `→ ${s("workspace")}`;
    default:                return "";
  }
}

export default function ChatPanel({ workspaceId, onAgentTurnComplete }: { workspaceId: string; onAgentTurnComplete?: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingTools, setPendingTools] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    setMessages([]);
    setDraft("");
  }, [workspaceId]);

  useEffect(() => {
    if (!streaming) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") abortRef.current?.abort();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [streaming]);

  async function sendMessage(userMessage: string) {
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setStreaming(true);

    let assistantContent = "";
    let assistantStarted = false;
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
              const content = assistantContent;
              if (!assistantStarted) {
                setMessages((prev) => [...prev, { role: "assistant", content }]);
                assistantStarted = true;
              } else {
                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = { role: "assistant", content };
                  return next;
                });
              }
            } else if (event.type === "tool_start") {
              setPendingTools((n) => n + 1);
              hadToolCalls = true;
              setMessages((prev) => [
                ...prev,
                { role: "tool_start", toolName: event.name, toolSummary: toolArgSummary(event.name, event.args), toolDone: false },
              ]);
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
      abortRef.current = null;
      setStreaming(false);
      setPendingTools(0);
      if (!wasAborted && !assistantStarted && hadToolCalls) {
        setMessages((prev) => [...prev, { role: "error", content: "Agent stopped without generating a response." }]);
      }
      onAgentTurnComplete?.();
    }
  }

  function handleSubmit() {
    if (!draft.trim() || streaming) return;
    sendMessage(draft.trim());
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 min-h-[44px] border-b border-border flex-shrink-0">
        <span className="font-semibold text-sm">Agent</span>
        <span className={"status-dot" + (streaming ? " is-running" : "")} />
        <span className="text-text-2 text-xs -ml-0.5">{streaming ? "Running" : "Idle"}</span>
      </div>

      <div className="flex-1 overflow-auto p-[14px_16px] flex flex-col gap-2">
        {messages.length === 0 && !streaming && (
          <div className="text-text-3 text-[13px] text-center mt-6">
            Ask the agent anything about this workspace.
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "tool_start") {
            return (
              <div key={i} className="flex flex-col gap-1.5 mb-1.5">
                <div className={`font-mono text-[12.5px] leading-[1.4] text-primary-2 px-0.5${m.toolDone ? " opacity-45" : ""}`}>
                  {m.toolDone
                    ? <span className="text-primary-2 mr-0.5">✓</span>
                    : <span className="inline-block w-2 h-2 border-[1.5px] border-primary-2 border-t-transparent rounded-full animate-[tool-spin_0.7s_linear_infinite] align-middle mr-0.5" />
                  }{" "}
                  <b>{toolLabel(m.toolName ?? "")}</b>
                  {m.toolSummary && <span className="text-text-3"> {m.toolSummary}</span>}
                </div>
                {m.toolResult && (
                  <div className="tool-result">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.toolResult}</ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }
          if (m.role === "limit_notice") {
            return (
              <div key={i} className="font-mono text-[12.5px] leading-[1.4] text-text-3 px-0.5 py-1">
                ⚠ Iteration limit reached — response may be incomplete.
              </div>
            );
          }
          if (m.role === "error") {
            return (
              <div key={i} className="px-0.5 py-1 text-[12.5px] text-danger">
                ✗ {m.content}
              </div>
            );
          }
          if (m.role === "assistant") {
            const content = m.content ?? "";
            if (!content.trim()) return null;
            return (
              <div key={i} className="flex justify-start">
                <div className="bubble-agent md-prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[84%] px-3 py-2 rounded-xl rounded-br-sm text-sm leading-[1.45] break-words bg-primary text-white whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          );
        })}

        {streaming && pendingTools === 0 && (
          <div className="flex justify-start">
            <div className="bubble-agent md-prose typing">
              <span /><span /><span />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2 px-3.5 pb-4 pt-3 border-t border-border bg-bg flex-shrink-0">
        <textarea
          ref={taRef}
          className="textarea min-h-[38px] max-h-[120px] overflow-auto"
          rows={1}
          value={draft}
          placeholder={streaming ? "Agent is running…" : "Ask the agent…"}
          disabled={streaming}
          onInput={(e) => {
            const t = e.target as HTMLTextAreaElement;
            t.style.height = "auto";
            t.style.height = Math.min(t.scrollHeight, 120) + "px";
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
          }}
        />
        <button
          className="w-9 h-9 rounded-lg border-0 bg-primary text-white inline-flex items-center justify-center cursor-pointer transition-[background,opacity] duration-[140ms] flex-none hover:bg-primary-2 disabled:opacity-45 disabled:cursor-not-allowed"
          disabled={!draft.trim() || streaming}
          onClick={handleSubmit}
          title="Send (Enter)"
        >
          {streaming
            ? <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-[spin_.8s_linear_infinite]" />
            : <SendIcon />
          }
        </button>
      </div>
    </div>
  );
}
