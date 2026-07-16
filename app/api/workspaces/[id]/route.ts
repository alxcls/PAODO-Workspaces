// REST endpoint for a single workspace.
// GET returns its metadata; DELETE removes it from the registry and deletes its directory from disk.
import { type NextRequest, NextResponse } from "next/server";
import { getStore, getContainers, getVersioning } from "@/lib/infra/services";
import { requireWorkspace, notFound } from "@/lib/api/guards";
import { disconnectWorkspace } from "@/lib/workspace/driveStore";
import { removeWorkspaceFromGraph } from "@/lib/workspace/workspaceGraph";
import { deleteKey } from "@/lib/infra/security/apiKeyStore";
import { rm } from "fs/promises";
import path from "path";
import { WORKSPACES_ROOT } from "@/lib/infra/paths";
import { SUPPORTED_PROVIDERS, getProviderMetadata } from "@/lib/agent/buildModel";
import { DEFAULT_LLM, type ReasoningEffort } from "@/lib/agent/interfaces";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({
    id: ws.id,
    name: ws.name,
    dir: ws.dir,
    createdAt: ws.createdAt,
    maxIterations: ws.maxIterations,
    description: ws.description ?? "",
    llmProvider: ws.llmProvider,
    llmModel: ws.llmModel,
    reasoningEffort: ws.reasoningEffort,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as {
    name?: string;
    maxIterations?: number;
    llmProvider?: string;
    llmModel?: string;
    reasoningEffort?: string;
    description?: string;
  };

  // Per-workspace LLM selection. All three fields are set together (the UI always sends the full
  // selection): provider is whitelisted against the supported set, model is a non-empty string (kept
  // free-form so a model not yet in the pricing catalog can still be used), and effort is checked
  // against THIS provider's accepted levels — they differ (OpenAI none…xhigh, Anthropic low…max). A
  // provider with no effort dial (DeepSeek) ignores the field, so we store a valid placeholder rather
  // than reject.
  if (body.llmProvider !== undefined || body.llmModel !== undefined || body.reasoningEffort !== undefined) {
    const provider = body.llmProvider;
    const model = body.llmModel?.trim();
    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "invalid llmProvider" }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: "llmModel required" }, { status: 400 });
    }
    const efforts = getProviderMetadata(provider).reasoningEfforts;
    let reasoningEffort = body.reasoningEffort;
    if (efforts.length === 0) {
      reasoningEffort = DEFAULT_LLM.reasoningEffort;
    } else if (!reasoningEffort || !efforts.includes(reasoningEffort as ReasoningEffort)) {
      return NextResponse.json({ error: "invalid reasoningEffort" }, { status: 400 });
    }
    const ok = getStore().setWorkspaceLlm(id, { provider, model, reasoningEffort: reasoningEffort as ReasoningEffort });
    if (!ok) return notFound();
    return NextResponse.json({ id, llmProvider: provider, llmModel: model, reasoningEffort });
  }

  if (body.maxIterations !== undefined) {
    const n = Math.max(1, Math.floor(Number(body.maxIterations)));
    if (!isFinite(n)) return NextResponse.json({ error: "invalid maxIterations" }, { status: 400 });
    const ok = getStore().setWorkspaceMaxIterations(id, n);
    if (!ok) return notFound();
    return NextResponse.json({ id, maxIterations: n });
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }
    const ok = getStore().setWorkspaceDescription(id, body.description);
    if (!ok) return notFound();
    return NextResponse.json({ id, description: body.description.trim() });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const ok = await getStore().renameWorkspace(id, body.name);
  if (!ok) return notFound();
  // Container bind mount is baked in at creation time — must recreate with new dir on next use.
  await getContainers().remove(id);
  return NextResponse.json({ id, name: body.name.trim() });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ deleted: false });
  await getStore().deleteWorkspace(id);
  disconnectWorkspace(id);
  removeWorkspaceFromGraph(id);
  deleteKey(id);
  await Promise.all([
    getContainers().remove(id),
    getContainers().deleteWorkspaceDir(ws.dir),
    // Version history must not outlive the workspace.
    getVersioning().deleteRepo(id),
    // Agent-permissions file written by the permission model — best-effort, may not exist.
    rm(path.join(WORKSPACES_ROOT, ".agent-permissions", `${id}.json`), { force: true }),
  ]);
  return NextResponse.json({ deleted: true });
}
