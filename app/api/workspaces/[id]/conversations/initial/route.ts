// The workspace screen's first load: the conversation list plus the newest one's transcript, so the chat
// renders without a second round-trip. Website-only, like GET /conversations/{id}.
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { getInitialWorkspaceConversations } from "@/lib/operations/conversations/manage";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = getInitialWorkspaceConversations(id);
  if (!result) return notFound(req, `workspace ${id}`);
  return Response.json(result);
}
