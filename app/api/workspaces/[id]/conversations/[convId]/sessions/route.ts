// A conversation's runs, newest first, each as the start of its message and answer. Read-only, so the CLI
// may call it; starting or stopping a run stays on the workspace API and MCP routes.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { listConversationSessions } from "@/lib/operations/conversations/sessions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  try {
    const result = listConversationSessions(id, convId);
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
}
