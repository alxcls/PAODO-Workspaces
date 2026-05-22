// Public agent endpoint authenticated via Bearer API key and protected by rate limiting.
// Runs the same agent loop as the chat route but is intended for external/programmatic access,
// streaming only tool_start events during execution and delivering the final response as a single payload.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { runAgent, type AgentEvent } from "@/lib/agent/runner";
import { buildSystemPrompt } from "@/lib/agent/systemPrompt";
import { validateKey } from "@/lib/infra/apiKeyStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";


export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const { id } = await params;

  if (!plain || !validateKey(id, plain)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ws = getWorkspace(id);
  if (!ws) return new Response("Not Found", { status: 404 });

  const body = (await req.json()) as { message?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let response = "";
      try {
        const isolatedMessages = [buildSystemPrompt(ws.dir)];
        for await (const event of runAgent(isolatedMessages, body.message!.trim(), ws.dir, ws.id)) {
          if (event.type === "token") {
            response += event.content;
          } else if (event.type === "tool_start") {
            send({ type: "tool_start", name: event.name });
          } else if (event.type === "error") {
            send({ type: "error", message: event.message });
          } else if (event.type === "done") {
            send({ type: "response", content: response });
            send({ type: "done" });
            break;
          }
        }
      } catch (err) {
        send({ type: "error", message: String(err) });
        send({ type: "done" });
      } finally {
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
