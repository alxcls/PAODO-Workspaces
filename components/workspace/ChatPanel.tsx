// Chat panel — renders the message thread and input bar for agent interaction.
"use client";

import { useState, useRef, useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentEvent } from "@/lib/agent/runner";

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);


interface Message {
  role: "user" | "assistant" | "tool_start" | "error";
  content: string;
  toolName?: string;
}

const TOOL_LABELS: Record<string, string> = {
  file_read:       "Reading file",
  file_write:      "Writing file",
  file_edit:       "Editing file",
  execute_command: "Running command",
  web_fetch:       "Fetching page",
  todo_write:      "Updating tasks",
  glob:            "Searching files",
  list_directory:  "Listing directory",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

export default function ChatPanel({ workspaceId, onAgentTurnComplete }: { workspaceId: string; onAgentTurnComplete?: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    setMessages([]);
    setDraft("");
  }, [workspaceId]);

  async function sendMessage(userMessage: string) {
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setStreaming(true);

    let assistantContent = "";
    let assistantStarted = false;

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
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
              if (!assistantStarted) {
                setMessages((prev) => [...prev, { role: "assistant", content: assistantContent }]);
                assistantStarted = true;
              } else {
                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = { role: "assistant", content: assistantContent };
                  return next;
                });
              }
            } else if (event.type === "tool_start") {
              setMessages((prev) => [
                ...prev,
                { role: "tool_start", content: `Running ${event.name}…`, toolName: event.name },
              ]);
            } else if (event.type === "error") {
              setMessages((prev) => [...prev, { role: "error", content: event.message }]);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } finally {
      setStreaming(false);
      onAgentTurnComplete?.();
      assistantContent = "";
      assistantStarted = false;
    }
  }

  function handleSubmit() {
    if (!draft.trim() || streaming) return;
    sendMessage(draft.trim());
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-title">Agent</span>
        <span className={"status-dot" + (streaming ? " is-running" : "")} />
        <span className="chat-status">{streaming ? "Running" : "Idle"}</span>
      </div>

      <div className="chat-body">
        {messages.length === 0 && !streaming && (
          <div style={{ color: "var(--text-3)", fontSize: 13, textAlign: "center", marginTop: 24 }}>
            Ask the agent anything about this workspace.
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "tool_start") {
            return (
              <div key={i} className="tool-inline">
                ▶ <b>{toolLabel(m.toolName ?? "")}</b>
              </div>
            );
          }
          if (m.role === "error") {
            return (
              <div key={i} style={{ display: "flex", justifyContent: "center" }}>
                <div
                  className="bubble"
                  style={{
                    background: "var(--danger-soft)",
                    color: "var(--danger)",
                    border: "1px solid var(--danger)",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  ✗ {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className={"msg msg-" + (m.role === "user" ? "user" : "agent")}>
              <div className={"bubble bubble-" + (m.role === "user" ? "user" : "agent")}>
                {m.role === "user"
                  ? m.content
                  : <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(m.content)) }} />}
              </div>
            </div>
          );
        })}

        {streaming && (
          <div className="msg msg-agent">
            <div className="bubble bubble-agent typing">
              <span /><span /><span />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
          <textarea
            ref={taRef}
            className="textarea chat-textarea"
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
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button
            className="send-btn"
            disabled={!draft.trim() || streaming}
            onClick={handleSubmit}
            title="Send (Enter)"
          >
            {streaming ? <span className="spinner" /> : <SendIcon />}
          </button>
      </div>
    </div>
  );
}
