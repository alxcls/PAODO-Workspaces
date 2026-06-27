// Chat panel — renders the message thread and input bar for agent interaction.
"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAgentStream, toolLabel, type Message } from "@/lib/client/hooks/useAgentStream";
import type { InitialConversation } from "@/lib/client/hooks/useConversations";

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

export default function ChatPanel({ workspaceId, conversationId, initialConversation, onAgentTurnComplete, onRunStart }: { workspaceId: string; conversationId: string | null; initialConversation?: InitialConversation | null; onAgentTurnComplete?: () => void; onRunStart?: () => void }) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Whether the view is "stuck" to the bottom. While true, new content auto-scrolls into view; once
  // the user scrolls up to read, it goes false and streaming stops yanking them back down.
  const pinnedRef = useRef(true);
  // The id whose inline payload we've already consumed, so we use it once (first paint) and then
  // always re-fetch — the payload can go stale once the conversation is used.
  const consumedInitialRef = useRef<string | null>(null);

  const { messages, streaming, pendingTools, sendMessage, attachLive, hydrate, reset, detach, stop } = useAgentStream(
    workspaceId,
    conversationId,
    { onTurnComplete: onAgentTurnComplete },
  );

  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: streaming ? "instant" : "smooth" });
  }, [messages, streaming]);

  // Recompute stickiness on scroll: pinned when within ~80px of the bottom (covers smooth-scroll
  // overshoot and sub-pixel rounding). Updating a ref avoids a re-render per scroll event.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // When a run begins, nudge the switcher to refresh so its "running" dot lights up immediately and
  // its (idle-stopped) polling restarts for the duration of the run.
  useEffect(() => {
    if (streaming) onRunStart?.();
  }, [streaming, onRunStart]);

  // Load the selected conversation: render its saved history, then re-attach to its in-flight run
  // (if any) to watch it continue live. Detaches the previous conversation's stream on switch.
  useEffect(() => {
    setDraft("");
    pinnedRef.current = true;
    if (!conversationId) { reset(); return; }
    let cancelled = false;
    // Fast path: the inline payload that came with the conversation list, used once on first paint.
    if (initialConversation?.id === conversationId && consumedInitialRef.current !== conversationId) {
      consumedInitialRef.current = conversationId;
      hydrate(initialConversation.transcript);
      if (initialConversation.running) attachLive(initialConversation.userInput);
      return () => { cancelled = true; detach(); };
    }
    (async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}`);
      if (cancelled || !res.ok) return;
      const data = (await res.json()) as { transcript: Message[]; running: boolean; userInput: string | null };
      hydrate(data.transcript);
      if (data.running) attachLive(data.userInput);
    })();
    return () => { cancelled = true; detach(); };
  }, [workspaceId, conversationId, hydrate, attachLive, reset, detach, initialConversation]);

  useEffect(() => {
    if (!streaming) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") stop();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [streaming, stop]);

  function handleSubmit() {
    if (!draft.trim() || streaming || !conversationId) return;
    const msg = draft.trim();
    setDraft("");
    if (taRef.current) taRef.current.style.height = "auto";
    pinnedRef.current = true;
    sendMessage(msg);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto p-[14px_16px] flex flex-col gap-2">
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
                {m.calleeConversationId && m.calleeWorkspaceId && (
                  <a
                    href={`/workspace/${m.calleeWorkspaceId}?conversation=${m.calleeConversationId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] leading-[1.4] text-primary hover:underline px-0.5 self-start"
                  >
                    {/* Show the same short id the callee's conversation switcher displays
                        (its title is id.slice(0, 8)), so the link matches what you see there. */}
                    ↳ View conversation {m.calleeConversationId.slice(0, 8)}
                    {m.calleeWorkspaceName ? ` with agent ${m.calleeWorkspaceName}` : ""} ↗
                  </a>
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
        {streaming ? (
          <button
            className="w-9 h-9 rounded-lg border-0 bg-danger text-white inline-flex items-center justify-center cursor-pointer transition-[background,opacity] duration-[140ms] flex-none hover:opacity-90"
            onClick={() => stop()}
            title="Stop (Esc)"
          >
            <span className="w-3 h-3 bg-white rounded-[2px]" />
          </button>
        ) : (
          <button
            className="w-9 h-9 rounded-lg border-0 bg-primary text-white inline-flex items-center justify-center cursor-pointer transition-[background,opacity] duration-[140ms] flex-none hover:bg-primary-2 disabled:opacity-45 disabled:cursor-not-allowed"
            disabled={!draft.trim() || !conversationId}
            onClick={handleSubmit}
            title="Send (Enter)"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}
