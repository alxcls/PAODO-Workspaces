import { type NextRequest, NextResponse } from "next/server";
import { deleteWorkspaceSecret } from "@/lib/operations/workspaceSecrets";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  const deleted = deleteWorkspaceSecret(id, name);
  if (deleted === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: deleted });
}
