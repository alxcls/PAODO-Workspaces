// Basic-authenticated settings endpoint used by the home-page CLI access modal.
//
// Deliberately absent from platformAccessPolicy.ts: the CLI token must never reach the route that
// mints or rotates it, so this endpoint stays UI-administrator-only. Uses the same credential handlers
// as the workspace API-key and MCP endpoints, with no subject since the token is instance-wide.
//
// PATCH no longer mints on first enable the way the old bespoke handler did. Enabling a channel and
// creating a secret are separate steps here, exactly as they already were for the API key and MCP
// secret — one flow for all three instead of a special case for this one.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { credentialHandlers } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";

const handlers = credentialHandlers<Record<string, never>>("platform", async () => null);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export function GET() {
  return NextResponse.json(state("platform"), { headers: { "Cache-Control": "no-store" } });
}
