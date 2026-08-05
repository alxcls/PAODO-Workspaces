// Explicitly stop a conversation's in-flight run. The runner observes the abort, finishes its
// current atomic turn (so history stays valid), and exits.
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { stopWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  const result = stopWorkspaceConversation(id, convId);
  if (!result) return notFound(_req);
  return Response.json({ stopped: result.stopped });
}
