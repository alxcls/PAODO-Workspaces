// SSE endpoint that streams agent events to the browser; validates the workspace API key, starts the runner, and keeps the connection alive.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import { validateKey } from "@/lib/infra/security/apiKeyStore";
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";
import { makeAgentStream } from "@/lib/agent/agentStream";

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "agent" });
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    log.warn({ ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const body = (await req.json()) as { workspace?: string; message?: string };

  if (!body.workspace?.trim()) return new Response("workspace is required", { status: 400 });
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const ws = getStore().getWorkspaceByName(body.workspace.trim());
  if (!ws) return new Response("Workspace not found", { status: 404 });

  if (!plain || !validateKey(ws.id, plain)) {
    log.warn({ ip, workspace: body.workspace }, "unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

  return makeAgentStream(ws, body.message!.trim(), log, {
    store: getStore(),
    containers: getContainers(),
    origin: "api",
  });
}
