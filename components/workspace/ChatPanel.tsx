// Chat panel — renders the message thread and input bar for agent interaction.
"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAgentStream, toolLabel } from "@/lib/client/hooks/useAgentStream";

const mdComponents: Components = {
  table: ({ node: _n, ...props }) => (
    <div className="table-wrap"><table {...props} /></div>
  ),
};

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

export default function ChatPanel({ workspaceId, onAgentTurnComplete }: { workspaceId: string; onAgentTurnComplete?: () => void }) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const { messages, streaming, pendingTools, sendMessage, reset, abort } = useAgentStream(workspaceId, {
    onTurnComplete: onAgentTurnComplete,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: streaming ? "instant" : "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    reset();
    setDraft("");
  }, [workspaceId, reset]);

  useEffect(() => {
    if (!streaming) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") abort();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [streaming, abort]);

  function handleSubmit() {
    if (!draft.trim() || streaming) return;
    const msg = draft.trim();
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    sendMessage(msg);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-[14px_16px] flex flex-col gap-2">
        {messages.length === 0 && !streaming && (
          <div className="text-text-3 text-ms text-center mt-6">
            Ask the agent anything about this workspace.
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "reasoning") {
            const content = m.content?.trim();
            if (!content) return null;
            return (
              <div key={i} className="text-[11.5px] text-text-3 italic px-0.5 py-0.5 leading-[1.5] [&_strong]:font-semibold [&_strong]:not-italic">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
              </div>
            );
          }
          if (m.role === "assistant" && m.thinking) {
            const content = m.content?.trim();
            if (!content) return null;
            return (
              <div key={i} className="text-[11.5px] text-text-3 italic px-0.5 py-0.5 leading-[1.5] [&_strong]:font-semibold [&_strong]:not-italic">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
              </div>
            );
          }
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
          if (m.role === "usage") {
            return (
              <div key={i} className="flex justify-start gap-2.5 px-0.5 text-2xs select-none">
                <span title="Input tokens" className="text-sky-800">↑ {m.inputTokens?.toLocaleString()}</span>
                <span title="Output tokens" className="text-orange-800">↓ {m.outputTokens?.toLocaleString()}</span>
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
