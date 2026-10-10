// One tool call of a session with its input and output in full. Read-only, so the CLI
// may call it; reasoning and the system prompt stay on the dashboard's routes.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { getConversationSessionCall } from "@/lib/operations/conversations/calls";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string; sessionId: string; callId: string }> },
) {
  const { id, convId, sessionId, callId } = await params;
  try {
    const result = getConversationSessionCall(id, convId, sessionId, callId);
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
}
