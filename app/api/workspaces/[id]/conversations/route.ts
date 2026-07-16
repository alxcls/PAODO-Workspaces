// Conversation list + creation for a workspace.
//   GET  → all conversations (newest-first), each flagged `running` if its agent is mid-run.
//          With `?include=active`, also inlines the newest conversation's transcript so the first
//          page load can render chat content without a second round-trip (see ChatPanel). Plain
//          GETs (the running-dot poll) skip this so they stay cheap.
//   POST → create a new conversation and make it active
import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import * as conversations from "@/lib/workspace/conversationStore";
import * as broker from "@/lib/agent/runBroker";
import { messagesToTranscript } from "@/lib/agent/messageSerialization";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const running = new Set(broker.runningConversationIds(id));
  const list = conversations.listConversations(id).map((m) => ({ ...m, running: running.has(m.id) }));

  let active = null;
  if (req.nextUrl.searchParams.get("include") === "active" && list.length > 0) {
    const convId = list[0].id;
    const isRunning = running.has(convId);
    // Persisted history only while running — the live in-memory array already holds the in-flight
    // user turn the client re-adds via its `userInput` echo (see [convId]/route.ts for the why).
    const messages = isRunning ? conversations.getPersistedMessages(id, convId) : conversations.getMessages(id, convId);
    if (messages) {
      active = {
        id: convId,
        transcript: messagesToTranscript(messages),
        running: isRunning,
        userInput: isRunning ? broker.peekUserInput(id, convId) : null,
      };
    }
  }
  return Response.json({ conversations: list, active });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const meta = conversations.createConversation(id);
  return Response.json({ conversation: { ...meta, running: false } }, { status: 201 });
}
