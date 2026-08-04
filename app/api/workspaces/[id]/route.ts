// REST endpoint for a single workspace.
// GET returns its metadata; DELETE removes it from the registry and deletes its directory from disk.
import { type NextRequest, NextResponse } from "next/server";
import { notFound, workspaceNameErrorResponse } from "@/lib/api/guards";
import { publicBaseUrl } from "@/lib/api/credentialRoutes";
import { getWorkspaceOverview } from "@/lib/operations/workspaceDetails";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { deleteWorkspace } from "@/lib/operations/workspaceDelete";
import { WorkspaceUpdateError, WorkspaceUpdateFailure } from "@/lib/operations/workspaceErrors";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const connectionOrigin = publicBaseUrl() ?? new URL(req.url).origin;
  const workspace = await getWorkspaceOverview(id, connectionOrigin);
  if (!workspace) return notFound();
  return NextResponse.json(workspace, { headers: { "Cache-Control": "no-store" } });
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
  const body = (await req.json()) as {
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
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }

  // Reject anything not on the list rather than ignoring it. A misspelled field alongside a valid one
  // would otherwise apply the valid half and return 200 with the typo absent from `updated` — a
  // partial change reported as a complete one, which no caller can detect. Both rejections name the
  // accepted fields, because a programmatic caller has no form to discover them from.
  const unknown = Object.keys(body).filter((key) => !(UPDATABLE_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `unknown field(s): ${unknown.join(", ")} — accepted: ${UPDATABLE_FIELDS.join(", ")}` },
      { status: 400 },
    );
  }
  const hasModel = body.llmProvider !== undefined || body.llmModel !== undefined || body.reasoningEffort !== undefined;
  const supplied = UPDATABLE_FIELDS.filter((field) => body[field] !== undefined);
  if (supplied.length === 0) {
    return NextResponse.json(
      { error: `no fields supplied — send at least one of: ${UPDATABLE_FIELDS.join(", ")}` },
      { status: 400 },
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
    if (!result) return notFound();
    // warnings carries the "saved but the container could not be stopped" case, which used to reach
    // only the internet-access route and was dropped here. no-store unconditionally: this response
    // carries a plaintext key whenever enabling a channel minted its first one.
    return NextResponse.json(
      {
        ...result.workspace,
        updated: result.updated,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.credentials ? { credentials: result.credentials } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const nameError = workspaceNameErrorResponse(err);
    if (nameError) return nameError;
    if (err instanceof WorkspaceUpdateError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof WorkspaceUpdateFailure) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await deleteWorkspace(id));
}
