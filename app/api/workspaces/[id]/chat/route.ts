// Internal chat endpoint used by the browser UI.
// Runs the agent loop and streams events (tokens, tool calls, errors) back as Server-Sent Events.
import type { NextRequest } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import { runAgent, type AgentEvent } from "@/lib/agent/runner";
import { buildSystemPrompt, buildPromptConfig } from "@/lib/agent/systemPrompt";
import { loadAgentConfig } from "@/lib/agent/tools";
import { createLogger } from "@/lib/infra/logger";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { getClientIp } from "@/lib/infra/clientIp";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const log = createLogger("api").child({ workspaceId: id, route: "chat" });
  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("Workspace not found", { status: 404 });

  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    log.warn({ ip }, "rate limit exceeded");
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const body = await req.json() as { message?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  // Refresh the system prompt on every request so AGENTS.md changes are always picked up.
  ws.messages[0] = buildSystemPrompt(ws.dir, buildPromptConfig(loadAgentConfig()));

  log.info("chat stream started");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runAgent(ws.messages, body.message!.trim(), ws.dir, ws.id, { signal: req.signal, maxIterations: ws.maxIterations, store: getStore(), containers: getContainers() })) {
          send(event);
          if (event.type === "done") break;
        }
      } catch (err) {
        log.error({ err }, "chat stream error");
        send({ type: "error", message: String(err) });
        send({ type: "done" });
      } finally {
        log.info("chat stream ended");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
