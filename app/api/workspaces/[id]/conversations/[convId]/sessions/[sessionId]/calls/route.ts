// A session's tool calls in execution order, each with the size of its input and output but not the text.
// Read-only, so the CLI may call it; one call's texts are ./[callId].
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { listConversationSessionCalls } from "@/lib/operations/conversations/calls";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string; sessionId: string }> },
) {
  const { id, convId, sessionId } = await params;
  try {
    const result = listConversationSessionCalls(id, convId, sessionId);
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
}
