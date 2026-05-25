export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getWorkspaceByName } from "@/lib/infra/workspaceStore";
import { validateKey } from "@/lib/infra/apiKeyStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { createLogger } from "@/lib/infra/logger";
import { makeAgentStream } from "@/lib/agent/agentStream";

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "agent" });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    log.warn({ ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const body = (await req.json()) as { workspace?: string; message?: string };

  if (!body.workspace?.trim()) return new Response("workspace is required", { status: 400 });
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const ws = getWorkspaceByName(body.workspace.trim());
  if (!ws) return new Response("Workspace not found", { status: 404 });

  if (!plain || !validateKey(ws.id, plain)) {
    log.warn({ ip, workspace: body.workspace }, "unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

  return makeAgentStream(ws, body.message!.trim(), log);
}
