// Returns the CURRENT system prompt text for a workspace, for the usage dashboard's
// collapsible "System prompt" section. The prompt is large and near-identical on every turn,
// so it is NOT stored per usage record — it is rebuilt on demand here (the same way the chat
// route rebuilds it per request), which keeps data/.usage.jsonl small. This reflects the prompt
// as it would be sent now (including the workspace's current AGENTS.md), not necessarily the
// exact text used at an older turn.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import { buildSystemPrompt, buildPromptConfig } from "@/lib/agent/systemPrompt";
import { buildWorkspacePromptInputs } from "@/lib/agent/promptContext";
import { loadAgentConfig } from "@/lib/agent/buildTools";

// The SystemMessage content is an array of text blocks; join their text into one string.
function systemPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: string }).text) : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("Workspace not found", { status: 404 });
  const inputs = buildWorkspacePromptInputs(ws.id, ws.dir);
  const msg = buildSystemPrompt(ws.dir, buildPromptConfig(loadAgentConfig(ws.id)), inputs);
  return NextResponse.json({ prompt: systemPromptText(msg.content) });
}
