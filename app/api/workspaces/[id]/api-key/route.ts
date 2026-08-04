// REST endpoint for managing a workspace's agent API key.
// GET returns the current state; POST mints/rotates the key (plaintext returned once); DELETE revokes
// it; PATCH toggles the channel. Everything but GET comes from the shared credential handlers.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { requireWorkspace } from "@/lib/api/guards";

type Params = { id: string };

const handlers = credentialHandlers<Params>(
  "workspace-api",
  // Guarded like the MCP route: an unchecked id would let a typo mint a key against a workspace that
  // does not exist, leaving an orphan credential record nothing ever cleans up.
  async ({ id }) => {
    const ws = requireWorkspace(id);
    return ws instanceof NextResponse ? ws : id;
  },
  {
    setEnabled: async (_kind, subject, enabled) => {
      const result = await updateWorkspace(subject as string, { workspaceApiAccess: enabled });
      if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
      // Enabling a channel that had no key mints its first one. Hand it back here or it is lost: the
      // store keeps only a hash, so this response is the single chance to read it.
      const plain = result.credentials?.workspaceApiKey;
      if (plain) {
        return NextResponse.json({ ok: true, plain }, { headers: { "Cache-Control": "no-store" } });
      }
    },
  },
);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export async function GET(_req: Request, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  return NextResponse.json(
    { ...state("workspace-api", id), publicBaseUrl: publicBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
