// A single conversation's saved transcript, for rendering when the user opens/switches to it.
// `transcript` is the persisted history only. If `running` is true, the in-flight run is NOT in
// the transcript (conversations persist at run end); the client appends `userInput` and then
// re-attaches to the live stream to watch the rest (see chat/route.ts attach mode).
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { getWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  try {
    const result = getWorkspaceConversation(id, convId);
    if (!result) return notFound(_req);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) return new Response("Conversation not found", { status: 404 });
    throw err;
  }
}
