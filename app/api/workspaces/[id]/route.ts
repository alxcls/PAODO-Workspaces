// REST endpoint for a single workspace.
// GET returns its metadata; DELETE removes it from the registry and deletes its directory from disk.
import { type NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { publicBaseUrl } from "@/lib/api/credentialRoutes";
import { receiptResponse } from "@/lib/api/workspaceUpdateReceipt";
import { getWorkspaceOverview } from "@/lib/operations/workspaceDetails";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { deleteWorkspace } from "@/lib/operations/workspaceDelete";

const log = createLogger("api").child({ route: "workspace" });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const connectionOrigin = publicBaseUrl() ?? new URL(req.url).origin;
    const workspace = await getWorkspaceOverview(id, connectionOrigin);
    if (!workspace) return notFound(req);
    return NextResponse.json(workspace, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error(
      {
        event: "workspace_read_failed",
        outcome: "workspace_not_returned",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to read workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to read workspace", { request: req });
  }
}

// The wire names PATCH accepts, in one place so the emptiness check, the unknown-field rejection and
// the error messages cannot drift apart. These are the request's field names, which differ from the
// operation's input shape: the three llm* fields arrive separately and become one `model`.
const UPDATABLE_FIELDS = [
  "name",
  "description",
  "maxIterations",
  "maxRunMinutes",
  "internetAccess",
  "workspaceApiAccess",
  "workspaceMcpAccess",
  "secret",
  "llmProvider",
  "llmModel",
  "reasoningEffort",
] as const;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as {
    name?: string;
    maxIterations?: number;
    maxRunMinutes?: number;
    llmProvider?: string;
    llmModel?: string;
    reasoningEffort?: string;
    description?: string;
    internetAccess?: boolean;
    workspaceApiAccess?: boolean;
    workspaceMcpAccess?: boolean;
    secret?: { name?: string; value?: string; domains?: string[] };
  };

  if (body.description !== undefined && typeof body.description !== "string") {
    return errorResponse("INVALID_REQUEST", "description must be a string", {
      request: req,
      details: { field: "description" },
    });
  }

  // Reject anything not on the list rather than ignoring it. A misspelled field alongside a valid one
  // would otherwise apply the valid half and return 200 with the typo absent from `applied` — a
  // partial change reported as a complete one, which no caller can detect. Both rejections name the
  // accepted fields, because a programmatic caller has no form to discover them from.
  const unknown = Object.keys(body).filter((key) => !(UPDATABLE_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return errorResponse(
      "INVALID_REQUEST",
      `unknown field(s): ${unknown.join(", ")} — accepted: ${UPDATABLE_FIELDS.join(", ")}`,
      { request: req, details: { fields: unknown, acceptedFields: [...UPDATABLE_FIELDS] } },
    );
  }
  const hasModel = body.llmProvider !== undefined || body.llmModel !== undefined || body.reasoningEffort !== undefined;
  const supplied = UPDATABLE_FIELDS.filter((field) => body[field] !== undefined);
  if (supplied.length === 0) {
    return errorResponse(
      "INVALID_REQUEST",
      `no fields supplied — send at least one of: ${UPDATABLE_FIELDS.join(", ")}`,
      { request: req, details: { acceptedFields: [...UPDATABLE_FIELDS] } },
    );
  }

  try {
    const result = await updateWorkspace(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.maxIterations !== undefined ? { maxIterations: body.maxIterations } : {}),
      ...(body.maxRunMinutes !== undefined ? { maxRunMinutes: body.maxRunMinutes } : {}),
      ...(body.internetAccess !== undefined ? { internetAccess: body.internetAccess } : {}),
      ...(body.workspaceApiAccess !== undefined ? { workspaceApiAccess: body.workspaceApiAccess } : {}),
      ...(body.workspaceMcpAccess !== undefined ? { workspaceMcpAccess: body.workspaceMcpAccess } : {}),
      ...(body.secret !== undefined
        ? {
            secret: {
              name: body.secret.name ?? "",
              value: body.secret.value ?? "",
              domains: body.secret.domains ?? [],
            },
          }
        : {}),
      // Omitted fields are forwarded as omitted, not as "": the operation resolves each missing one
      // from the workspace's current choice, so any subset of the three is a complete request.
      ...(hasModel
        ? {
            model: {
              ...(body.llmProvider !== undefined ? { provider: body.llmProvider } : {}),
              ...(body.llmModel !== undefined ? { model: body.llmModel } : {}),
              ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
            },
          }
        : {}),
    });
    if (!result) return notFound(req);
    // A mutation returns only its receipt. GET is the sole workspace representation, so adding a
    // projection there (skills, secrets, access state) can never make PATCH partial or expensive.
    return receiptResponse(result);
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_update_failed",
        outcome: "workspace_not_updated",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to update workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to update workspace", { request: req });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await deleteWorkspace(id));
  } catch {
    // The deletion operation logs the exact failed cleanup stage once; do not duplicate the private
    // exception here. This boundary only converts it to the safe public contract.
    return errorResponse("INTERNAL_ERROR", "failed to delete workspace", { request: req });
  }
}
