// Public counterpart to the UI stop route, authenticated with the per-workspace Bearer API key.
// Lets an external caller (the same one that started a run via POST .../agent) stop that run: the
// runner observes the abort, finishes its current atomic turn so history stays valid, and exits.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { authenticateWorkspaceApi } from "@/lib/api/workspaceApiAuth";
import { notFound } from "@/lib/api/guards";
import { stopWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = authenticateWorkspaceApi(req, id, "agent-stop");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { conversationId?: string };
  if (!body.conversationId?.trim()) return new Response("conversationId is required", { status: 400 });

  const result = stopWorkspaceConversation(id, body.conversationId);
  if (!result) return notFound(req);
  return Response.json({ stopped: result.stopped, conversationId: result.conversationId });
}
