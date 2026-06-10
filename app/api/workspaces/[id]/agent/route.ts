// Public agent endpoint authenticated via Bearer API key and protected by rate limiting.
// Runs the same agent loop as the chat route but is intended for external/programmatic access,
// streaming only tool_start events during execution and delivering the final response as a single payload.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import { validateKey } from "@/lib/infra/apiKeyStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { getClientIp } from "@/lib/infra/clientIp";
import { createLogger } from "@/lib/infra/logger";
import { makeAgentStream } from "@/lib/agent/agentStream";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const { id } = await params;
  const log = createLogger("api").child({ workspaceId: id, route: "agent" });

  if (!plain || !validateKey(id, plain)) {
    log.warn({ ip }, "unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("Not Found", { status: 404 });

  const body = (await req.json()) as { message?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  return makeAgentStream(ws, body.message!.trim(), log, { store: getStore(), containers: getContainers() });
}
