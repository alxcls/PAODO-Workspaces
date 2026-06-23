// Roll a workspace back to a previous versioning commit (hard reset of the work-tree). Mutating +
// destructive, so it's rate-limited like the other write endpoints. The reset writes host files
// that bind-mount live into the container, so no container restart is needed.
import { type NextRequest, NextResponse } from "next/server";
import { getStore, getVersioning } from "@/lib/infra/services";
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";

const SHA = /^[0-9a-fA-F]{4,40}$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json()) as { sha?: string };
  if (!body.sha || !SHA.test(body.sha)) return NextResponse.json({ error: "invalid sha" }, { status: 400 });

  const restored = await getVersioning().restore(ws.id, ws.dir, body.sha);
  if (!restored) return NextResponse.json({ error: "unknown sha" }, { status: 400 });
  return NextResponse.json({ restored: true });
}
