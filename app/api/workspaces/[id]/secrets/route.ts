import { type NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { listSecrets, setSecret, deleteSecret } from "@/lib/infra/secretsStore";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ secrets: listSecrets(id) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { name, value } = (await req.json()) as { name?: string; value?: string };
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (value === undefined) return NextResponse.json({ error: "value required" }, { status: 400 });
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name.trim())) {
    return NextResponse.json({ error: "name must be a valid env-var identifier" }, { status: 400 });
  }

  setSecret(id, name.trim(), value);
  return NextResponse.json({ name: name.trim() });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const deleted = deleteSecret(id, name);
  return NextResponse.json({ deleted });
}
