// Public agent endpoint authenticated via Bearer API key and protected by rate limiting.
// Runs the same agent loop as the chat route but is intended for external/programmatic access,
// streaming only tool_start events during execution and delivering the final response as a single payload.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import { requireWorkspace, rateLimited } from "@/lib/api/guards";
import { validateKey } from "@/lib/infra/security/apiKeyStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";
import { makeAgentStream } from "@/lib/agent/agentStream";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limited = rateLimited(req, { logContext: { workspaceId: id } });
  if (limited) return limited;

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const log = createLogger("api").child({ workspaceId: id, route: "agent" });

  if (!plain || !validateKey(id, plain)) {
    log.warn({ ip: getClientIp(req) }, "unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { message?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const sessionId = crypto.randomUUID();
  return makeAgentStream(ws, body.message!.trim(), log, {
    store: getStore(),
    containers: getContainers(),
    sessionId,
    workspaceId: ws.id,
    workspaceName: ws.name,
  });
}
