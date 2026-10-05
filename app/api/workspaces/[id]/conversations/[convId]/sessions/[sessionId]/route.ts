// One run of a conversation: its dashboard row plus the user message and final answer, each cut to a
// fixed length. Read-only, so the CLI may call it; tool steps and prompts stay on the dashboard's routes.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { getConversationSession } from "@/lib/operations/conversations/sessions";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string; sessionId: string }> },
) {
  const { id, convId, sessionId } = await params;
  try {
    const result = getConversationSession(id, convId, sessionId);
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
}
