// Per-workspace agent file-restriction store (see the mount-topology ADR). The user keys paths here
// from the file tree (eye = deny-read, lock = deny-edit, key = privileged script). These are the
// SOURCE OF TRUTH; the agent container's mount topology is recomposed from them on its next
// (re)create — a "flip" — which the container manager detects via the perms-hash label.
//
// GET   -> the current store { denyRead, denyEdit, privilegedScripts }.
// PATCH -> toggle one path in one list: { list, path, on }.
//
// Keying is USER-ONLY: there is no agent tool that writes here, so the agent can never grant itself
// access or clear a flag. Writes are rate-limited like the other mutating endpoints.
import { type NextRequest, NextResponse } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import {
  loadPermissions,
  setPermission,
  type PermList,
} from "@/lib/infra/docker/agentPermissionStore";
import { PolicyError } from "@/lib/infra/docker/agentPermissions";
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";

const LISTS: readonly PermList[] = ["denyRead", "denyEdit", "privilegedScripts"];

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(loadPermissions(id));
  } catch (err) {
    // A corrupt store fails closed at container build; surface it here too rather than 500-ing blank.
    return NextResponse.json({ error: err instanceof PolicyError ? err.message : "failed to read permissions" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { list?: string; path?: string; on?: boolean };
  if (!body.list || !LISTS.includes(body.list as PermList)) {
    return NextResponse.json({ error: "invalid list (expected denyRead|denyEdit|privilegedScripts)" }, { status: 400 });
  }
  if (typeof body.path !== "string" || typeof body.on !== "boolean") {
    return NextResponse.json({ error: "expected { list, path, on }" }, { status: 400 });
  }

  try {
    const updated = setPermission(id, body.list as PermList, body.path, body.on);
    // Eagerly apply the new mount topology (commit-preserving recreate) off the request path, so the
    // next command finds an already-flipped container instead of paying the commit+recreate cost on
    // its critical path. Fire-and-forget and idle-gated; a no-op when the topology is unchanged
    // (e.g. a privilege toggle that didn't move a deny-edit), so it's always safe to call.
    void getContainers().requestFlip(id, ws.dir);
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof PolicyError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
