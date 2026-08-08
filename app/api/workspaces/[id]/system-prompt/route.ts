// Returns the CURRENT system prompt text for a workspace, for the usage dashboard's
// collapsible "System prompt" section. The prompt is large and near-identical on every turn,
// so it is NOT stored per usage record — it is rebuilt on demand here (the same way the chat
// route rebuilds it per request), avoiding a duplicate copy in every execution record. This
// reflects the prompt as it would be sent now (including the workspace's current AGENTS.md), not
// necessarily the exact text used at an older turn.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { workspaceSystemPromptText } from "@/lib/agent/workspacePrompt";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({ prompt: workspaceSystemPromptText(ws) });
}
