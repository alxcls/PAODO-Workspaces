// Loads and tracks a workspace's conversations for the switcher. Picks the newest as active on
// first load (creating one if the workspace has none), exposes create/select, and a refresh that
// re-reads titles/order and the per-conversation `running` flag without disturbing the selection.
"use client";

import { useState, useEffect, useCallback } from "react";
import type { Message } from "@/lib/client/agentTranscript";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  running: boolean;
}

// The newest conversation's full payload, delivered inline with the list on first load so the chat
// can render immediately — no separate fetch (see ChatPanel's fast path).
export interface InitialConversation {
  id: string;
  transcript: Message[];
  running: boolean;
  userInput: string | null;
}

export function useConversations(workspaceId: string) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [initial, setInitial] = useState<InitialConversation | null>(null);

  const refresh = useCallback(async (): Promise<ConversationMeta[]> => {
    const res = await fetch(`/api/workspaces/${workspaceId}/conversations`);
    if (!res.ok) return [];
    const { conversations } = (await res.json()) as { conversations: ConversationMeta[] };
    setConversations(conversations);
    return conversations;
  }, [workspaceId]);

  const create = useCallback(async (): Promise<string | null> => {
    const res = await fetch(`/api/workspaces/${workspaceId}/conversations`, { method: "POST" });
    if (!res.ok) return null;
    const { conversation } = (await res.json()) as { conversation: ConversationMeta };
    setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
    setActiveId(conversation.id);
    return conversation.id;
  }, [workspaceId]);

  // Initial load for the workspace: pick the newest conversation (or create the first one). One
  // combined request (`include=active`) also brings back that conversation's transcript so the chat
  // renders without a second round-trip.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setActiveId(null); // clear any selection carried over from a previous workspace
      setInitial(null);
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations?include=active`);
      if (cancelled || !res.ok) return;
      const { conversations, active } = (await res.json()) as {
        conversations: ConversationMeta[];
        active: InitialConversation | null;
      };
      if (cancelled) return;
      setConversations(conversations);
      if (conversations.length === 0) { await create(); return; }
      setInitial(active);
      setActiveId(conversations[0].id);
    })();
    return () => { cancelled = true; };
  }, [workspaceId, create]);

  // Keep the per-conversation "running" dot fresh, but only while a run is actually in flight — so an
  // idle workspace makes zero background requests. Polling starts when something is running (a local
  // run flips a conversation's `running` flag, or `kick()` is called when a run begins) and stops
  // itself on the first poll that finds nothing running.
  const anyRunning = conversations.some((c) => c.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => { void refresh(); }, 2500);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  return { conversations, activeId, setActiveId, create, refresh, initial };
}
