// Slim header above the chat: the active conversation's title with a dropdown to switch between
// saved conversations (a pulsing dot marks one whose agent is currently running) and a button to
// start a new one.
"use client";

import { useState, useRef, useEffect } from "react";
import type { ConversationMeta } from "@/lib/client/hooks/useConversations";

const ChevronIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const RunningDot = () => (
  <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary-2 animate-pulse flex-none" title="Agent running" />
);

export default function ConversationBar({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div
      ref={ref}
      className="relative flex items-center gap-1 px-4 min-h-[44px] border-b border-border bg-bg flex-shrink-0"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 min-w-0 max-w-full text-left px-1.5 py-1 rounded-md hover:bg-bg-2 cursor-pointer text-[12.5px] text-text-2"
        title="Switch conversation"
      >
        {active?.running && <RunningDot />}
        <span className="truncate font-medium">{active?.title ?? "Conversation"}</span>
        <span className="text-text-3 flex-none">
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div className="absolute left-2 top-[calc(100%-2px)] z-20 w-[min(320px,calc(100%-1rem))] max-h-[280px] overflow-auto rounded-lg border border-border bg-bg shadow-lg py-1">
          <button
            type="button"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] text-text-2 hover:bg-bg-2 cursor-pointer border-b border-border"
          >
            <span className="text-text-3 flex-none text-base leading-none">+</span>
            <span className="truncate flex-1">New conversation</span>
          </button>
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onSelect(c.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-bg-2 cursor-pointer ${c.id === activeId ? "text-primary-2 font-medium" : "text-text-2"}`}
            >
              {c.running ? <RunningDot /> : <span className="w-1.5 flex-none" />}
              <span className="truncate flex-1">{c.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
