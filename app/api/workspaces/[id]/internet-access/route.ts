// REST endpoint for a workspace's internet-access toggle. GET returns current state; PATCH flips it.
// PATCH also stops the running container so its network is torn down and rebuilt with the correct
// --internal flag on next use (containerManager.ts) — the toggle only becomes a real network-layer
// boundary once that happens, not merely once the setting is persisted.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { setWorkspaceInternetAccess } from "@/lib/workspace/workspaceStore";
import { setInternetAccessPolicy } from "@/lib/infra/proxy/internetAccessPolicy";
import { getContainers } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api");

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({ enabled: ws.internetAccess });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const { enabled } = (await req.json()) as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const previous = ws.internetAccess;
  setWorkspaceInternetAccess(id, enabled);

  try {
    setInternetAccessPolicy(id, enabled);
  } catch (err) {
    // Keep the store and the proxy's policy file from disagreeing — a workspace record saying
    // "off" while the policy file (still holding the old value) says "on" would silently weaken
    // the defense-in-depth check in credentialProxy.ts.
    setWorkspaceInternetAccess(id, previous);
    log.error(
      { event: "internet_access_toggle_failed", outcome: "rolled_back", err, workspaceId: id },
      "failed to persist internet-access policy — rolled back",
    );
    return NextResponse.json({ error: "failed to persist internet-access policy" }, { status: 500 });
  }

  try {
    await getContainers().stop(id);
  } catch (err) {
    // Store + policy already agree on `enabled` at this point; only the currently-running
    // container (if any) hasn't caught up. containerManager folds internetAccess into the
    // secrets-hash it checks on every ensure(), so the next wake forces a correct recreate
    // regardless of whether stop() succeeded here — a delayed cutover, not a lost setting. Don't
    // roll back the store/policy over a transient docker failure; that would silently revert an
    // explicit user action.
    log.error(
      {
        event: "internet_access_toggle_stop_failed",
        outcome: "setting_saved_container_pending",
        err,
        workspaceId: id,
      },
      "internet-access setting saved but failed to stop the running container",
    );
    return NextResponse.json(
      { ok: true, warning: "setting saved but the running container could not be stopped immediately" },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true });
}
