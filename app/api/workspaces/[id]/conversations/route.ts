// GET lists a workspace's conversations newest first, each flagged `running` mid-run, and never a transcript;
// POST creates one and makes it active. The workspace screen's first load, with a transcript, is ./initial.
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { createWorkspaceConversation, listWorkspaceConversations } from "@/lib/operations/conversations/manage";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = listWorkspaceConversations(id);
  if (!result) return notFound(req, `workspace ${id}`);
  return Response.json(result);
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = createWorkspaceConversation(id);
  if (!result) return notFound(_req, `workspace ${id}`);
  return Response.json({ conversation: result.conversation }, { status: 201 });
}
