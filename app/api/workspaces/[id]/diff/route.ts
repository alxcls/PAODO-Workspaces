// Unified diff between two versioning commits of a workspace.
import { type NextRequest, NextResponse } from "next/server";
import { getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";

// Defense-in-depth: args are passed to git as an argv array (no shell), but constraining shas to
// hex / HEAD-relative refs keeps anything weird out of the diff command.
const SHA = /^[0-9a-fA-F]{4,40}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
  if (!SHA.test(from) || !SHA.test(to)) return NextResponse.json({ error: "invalid sha" }, { status: 400 });

  const diff = await getVersioning().diff(ws.id, ws.dir, from, to);
  return NextResponse.json({ diff });
}
