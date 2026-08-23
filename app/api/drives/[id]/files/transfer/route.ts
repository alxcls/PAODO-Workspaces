// Streaming tar transport for a shared drive: one file, a directory tree, or the drive root.
//
// The transport itself is lib/api/fileTransferRoutes.ts, shared with the workspace route, so a push
// and a pull mean the same thing and refuse the same archives on either side.
//
// No versioning is passed. A drive is passive host storage with no git repository behind it, so there
// is no revision a push could be undone from — the same fact that makes `drive rm` final. The
// workspace route fails a push whose snapshot could not be written; here there is nothing to fail
// over, and a snapshot hook that quietly did nothing would be the worse answer of the two.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { rateLimited, requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { getFileTransfer, putFileTransfer } from "@/lib/api/fileTransferRoutes";

function backend(id: string) {
  return { dir: driveContentDir(id), logContext: { driveId: id, route: "drive-files/transfer" } };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return getFileTransfer(req, backend(id));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The same upload budget a workspace push spends, scoped to this drive. A drive is reachable by
  // every workspace connected to it, so an unbudgeted push here is the one write in the file surface
  // that lands in more than one agent's view at once.
  const limited = rateLimited(req, { policy: "upload", scope: id, logContext: { driveId: id } });
  if (limited) return limited;

  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return putFileTransfer(req, backend(id));
}
