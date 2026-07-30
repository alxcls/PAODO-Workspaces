// REST endpoint for managing a workspace's agent API key.
// GET returns the current state; POST mints/rotates the key (plaintext returned once); DELETE revokes
// it; PATCH toggles the channel. Everything but GET comes from the shared credential handlers.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";

type Params = { id: string };

const handlers = credentialHandlers<Params>("workspace-api", async ({ id }) => id);

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
