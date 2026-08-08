// REST endpoint for a workspace's third-party secrets: GET lists their safe metadata, POST stores
// one. POST answers with the stored secret's metadata rather than the full update receipt — the
// caller needs the derived fields (createdAt, blockedBy) this endpoint is about, and the value is
// never echoed.
import { type NextRequest, NextResponse } from "next/server";
import { notFound, requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { listWorkspaceSecrets } from "@/lib/operations/workspace/secrets";
import { updateWorkspace } from "@/lib/operations/workspace/update";

const log = createLogger("api").child({ route: "env-vars" });
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  // Shared with the workspace-details route so the UI block and CLI report one identical shape.
  // no-store like every other credential-adjacent response: the values never appear here, but which
  // secrets exist and what hosts they are scoped to is not something to leave in an intermediary.
  return NextResponse.json(listWorkspaceSecrets(id), { headers: NO_STORE });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { name?: string; value?: string; domains?: string[] };

  try {
    // Missing fields are forwarded as empty rather than rejected here: the shared validator owns the
    // name, value and domain rules, so this route cannot state a narrower version of them.
    const result = await updateWorkspace(id, {
      secret: { name: body.name ?? "", value: body.value ?? "", domains: body.domains ?? [] },
    });
    if (!result) return notFound(req);
    return NextResponse.json(result.values.secret, { headers: NO_STORE });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_secret_store_failed",
        outcome: "secret_not_stored",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to store the secret",
    );
    return errorResponse("INTERNAL_ERROR", "failed to store the secret", { request: req });
  }
}
