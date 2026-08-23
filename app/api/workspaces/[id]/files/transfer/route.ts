// Streaming tar transport used by the CLI for one file, a directory tree, or the workspace root.
//
// The transport itself is lib/api/fileTransferRoutes.ts, shared with the drive route. What is left
// here is what only a workspace has: a rate-limit budget shared with the browser's upload, and the git
// snapshot that makes a push undoable. The drive route passes no versioning at all — see that module
// for why that is a statement about the space rather than a shortcut.
//
// A pull is not rate limited; a push spends the same budget as the browser's upload. See PUT below for
// why that is parity rather than a bound.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { rateLimited, requireWorkspace } from "@/lib/api/guards";
import { changed, getFileTransfer, putFileTransfer } from "@/lib/api/fileTransferRoutes";
import { getVersioning } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";
import { flushSnapshotBurstStrict, snapshotWorkspaceStrict } from "@/lib/infra/git/snapshotWorkspace";
import type { PutTransferReceipt } from "@/lib/operations/files/transfer";

const log = createLogger("api");

function backend(id: string, dir: string) {
  return { dir, logContext: { workspaceId: id, route: "workspace-files/transfer" } };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return getFileTransfer(req, backend(id, ws.dir));
}

/**
 * Commit the pushed tree so the transfer is undoable from version history, and report only whether
 * that succeeded. The commit sha is deliberately not returned to the client: it names a snapshot of
 * the whole workspace rather than of what was pushed, so a caller reading it beside a list of pushed
 * paths reads it as an identifier for those paths, which it is not. History and restore are where a
 * revision is chosen, and both name it in a context that makes clear what it covers.
 */
async function snapshot(id: string, ws: { id: string; dir: string }, receipt: PutTransferReceipt): Promise<boolean> {
  try {
    await snapshotWorkspaceStrict(
      getVersioning(),
      ws,
      changed(receipt) === 1 ? "put 1 workspace entry" : `put ${changed(receipt)} workspace entries`,
    );
    return true;
  } catch (err) {
    log.error(
      { event: "file_transfer_snapshot_failed", outcome: "transfer_applied_without_snapshot", workspaceId: id, err },
      "failed to snapshot imported workspace transfer",
    );
    return false;
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The same bucket the browser's folder upload spends, so one client cannot bypass the upload budget
  // by choosing the other transport. Note what this does and does not buy: a whole-tree push is a
  // single request and so spends a single token, which makes this parity of policy rather than a bound
  // on the request. What actually bounds one transfer is MAX_TRANSFER_ENTRIES and MAX_TRANSFER_BYTES.
  const limited = rateLimited(req, { policy: "upload", scope: id, logContext: { workspaceId: id } });
  if (limited) return limited;

  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return putFileTransfer(req, backend(id, ws.dir), {
    beforeApply: async () => {
      await flushSnapshotBurstStrict(getVersioning(), ws);
    },
    commit: (receipt) => snapshot(id, ws, receipt),
  });
}
