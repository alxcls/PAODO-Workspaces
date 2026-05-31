// REST endpoint for managing a workspace's API key.
// GET returns current key state; POST generates a new key (returning the plaintext once); DELETE revokes it; PATCH toggles it on/off.
export const runtime = "nodejs";

import { generateKey, setKey, revokeKey, setEnabled, getState } from "@/lib/infra/apiKeyStore";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { keyHash, enabled } = getState(id);
  return Response.json({ enabled, hasKey: keyHash !== null });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { plain, hash } = generateKey();
  setKey(id, hash);
  return Response.json({ plain });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  revokeKey(id);
  return Response.json({ ok: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { enabled } = (await req.json()) as { enabled: boolean };
  setEnabled(id, enabled);
  return Response.json({ ok: true });
}
