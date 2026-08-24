// Returns the workspace file tree as a nested JSON structure for the file tree panel. One key, holding
// the one thing this route is named after.
//
// It used to serve two more, and both are gone:
//
//   - `ignore`, the effective ignore contract, bundled here on the reasoning that a client asking
//     "what is in this workspace" should get "and here is what never travels" in the same answer. It
//     put 223 bytes of a global constant on every listing to spare the CLI's push from uploading what
//     would be refused anyway — a bandwidth saving for a command that does not list, paid for by every
//     command that does. The push now sends everything and lets the transfer route refuse on arrival,
//     which it already did (lib/operations/files/transfer.ts), so nothing needs this served at all.
//   - `truncated`, which restated what the caller's own ?depth= already said and which nothing read.
//     A caller that asks for full depth knows it asked.
//
// Both were dropped rather than moved: no client reads either one now. If a client ever needs the
// ignore contract again, it wants its own address — the list is identical for every workspace, so it
// was never workspace data.
//
// The query string this reads and what it answers with are lib/api/fileTreeRoutes.ts, shared with the
// drive route so a client navigates both the same way.
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { getFileTree } from "@/lib/api/fileTreeRoutes";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return getFileTree(req, { dir: ws.dir, logContext: { workspaceId: id, route: "workspace-files" } });
}
