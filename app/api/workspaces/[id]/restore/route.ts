// Roll a workspace back to a previous versioning commit (hard reset of the work-tree). Mutating +
// destructive, so it's rate-limited like the other write endpoints. The reset writes host files
// that bind-mount live into the container, so no container restart is needed.
import { type NextRequest, NextResponse } from "next/server";
import { getVersioning } from "@/lib/infra/services";
import { requireWorkspace, rateLimited } from "@/lib/api/guards";

const SHA = /^[0-9a-fA-F]{4,40}$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limited = rateLimited(req, { logContext: { workspaceId: id } });
  if (limited) return limited;

  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { sha?: string };
  if (!body.sha || !SHA.test(body.sha)) return NextResponse.json({ error: "invalid sha" }, { status: 400 });

  const restored = await getVersioning().restore(ws.id, ws.dir, body.sha);
  if (!restored) return NextResponse.json({ error: "unknown sha" }, { status: 400 });
  return NextResponse.json({ restored: true });
}
