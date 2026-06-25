// A single conversation's saved transcript, for rendering when the user opens/switches to it.
// `transcript` is the persisted history only. If `running` is true, the in-flight run is NOT in
// the transcript (conversations persist at run end); the client appends `userInput` and then
// re-attaches to the live stream to watch the rest (see chat/route.ts attach mode).
import type { NextRequest } from "next/server";
import { getStore } from "@/lib/infra/services";
import * as conversations from "@/lib/workspace/conversationStore";
import * as broker from "@/lib/agent/runBroker";
import { messagesToTranscript } from "@/lib/agent/messageSerialization";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("Workspace not found", { status: 404 });

  const meta = conversations.getMeta(id, convId);
  const messages = conversations.getMessages(id, convId);
  if (!meta || !messages) return new Response("Conversation not found", { status: 404 });

  const running = broker.isRunning(id, convId);
  return Response.json({
    meta,
    running,
    userInput: running ? broker.peekUserInput(id, convId) : null,
    transcript: messagesToTranscript(messages),
  });
}
