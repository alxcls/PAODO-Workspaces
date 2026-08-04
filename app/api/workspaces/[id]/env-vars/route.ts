import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { listWorkspaceSecrets } from "@/lib/operations/workspaceSecrets";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { WorkspaceUpdateError } from "@/lib/operations/workspaceErrors";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  // Shared with the workspace-details route so the UI block and CLI report one identical shape.
  return NextResponse.json(listWorkspaceSecrets(id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { name?: string; value?: string; domains?: string[] };
  try {
    const result = await updateWorkspace(id, {
      secret: {
        name: body.name ?? "",
        value: body.value ?? "",
        domains: body.domains ?? [],
      },
    });
    if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(result.secret);
  } catch (err) {
    if (err instanceof WorkspaceUpdateError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
