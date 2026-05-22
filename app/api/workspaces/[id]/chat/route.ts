// Internal chat endpoint used by the browser UI.
// Runs the agent loop and streams events (tokens, tool calls, errors) back as Server-Sent Events.
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { runAgent, type AgentEvent } from "@/lib/agent/runner";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return new Response("Workspace not found", { status: 404 });

  const body = await req.json() as { message?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runAgent(ws.messages, body.message!.trim(), ws.dir, ws.id)) {
          send(event);
          if (event.type === "done") break;
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
