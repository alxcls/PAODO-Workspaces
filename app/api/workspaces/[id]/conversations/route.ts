// Conversation list + creation for a workspace.
//   GET  → all conversations (newest-first), each flagged `running` if its agent is mid-run.
//          With `?include=active`, also inlines the newest conversation's transcript so the first
//          page load can render chat content without a second round-trip (see ChatPanel). Plain
//          GETs (the running-dot poll) skip this so they stay cheap.
//   POST → create a new conversation and make it active
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { createWorkspaceConversation, listWorkspaceConversations } from "@/lib/operations/conversations/manage";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = listWorkspaceConversations(id, {
    includeActive: req.nextUrl.searchParams.get("include") === "active",
  });
  if (!result) return notFound(req);
  return Response.json(result);
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = createWorkspaceConversation(id);
  if (!result) return notFound(_req);
  return Response.json({ conversation: result.conversation }, { status: 201 });
}
