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
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse } from "@/lib/api/errorResponse";
import { AppError } from "@/lib/errors/appError";
import { createLogger } from "@/lib/infra/logger";
import { listEntries } from "@/lib/operations/files/listing";

const log = createLogger("api");

/**
 * `?depth=`, in levels below the directory listed: a positive integer for that many, "full" for all of
 * them, absent for the file panel's own rendering budget (lib/files/tree.ts).
 *
 * It used to be a two-way toggle — the panel's budget, or everything — because the only non-panel
 * client wanted everything: a truncation a program cannot see is a wrong answer rather than a short
 * one. A client that navigates wants neither. Asking for one level and listing a directory to descend
 * into it is not a truncation, because every directory in the answer is visibly a directory the caller
 * can ask about next, so the depth belongs to the caller and is a number rather than a flag.
 *
 * A depth this cannot read is refused rather than rounded to the default, for the same reason the panel
 * stopped being handed `truncated`: a listing is what a caller decides what to read or delete from
 * next, and quietly answering with a different tree than the one asked for leaves nothing in the
 * response to say so.
 */
function requestedDepth(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (value === "full") return Infinity;
  const levels = Number(value);
  if (!Number.isInteger(levels) || levels < 1) {
    throw new AppError("INVALID_REQUEST", `depth must be a positive integer or "full", got "${value}"`, {
      field: "depth",
    });
  }
  return levels;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  const { searchParams } = new URL(req.url);
  // Absent means the root, so the panel's own request is unchanged. A caller that names a directory
  // gets that subtree, still with root-relative paths — see listEntries for why the route does not
  // filter a full listing instead.
  const source = searchParams.get("path");

  try {
    const depth = requestedDepth(searchParams.get("depth"));
    // `?measure=1` — how big each file is, and how many lines it has. Opt-in because it is the one
    // thing a listing can be asked for that costs a read per entry, and the panel that makes most of
    // these requests renders neither. A client choosing a `cat` window asks for it; nothing else does.
    // `?count=1` — how many files sit under each directory, at any depth. Opt-in for the same reason and
    // with the same shape as ?measure=1: a one-level listing has to walk everything below it to answer,
    // which is a cost the panel must not pay for a number it does not render. The caller it is for is the
    // one deciding where to look next, and cannot see from a tree alone which directory is enormous.
    const tree = await listEntries(ws.dir, source, {
      ...(depth === undefined ? {} : { maxDepth: depth }),
      ...(searchParams.get("measure") === "1" ? { measure: true } : {}),
      ...(searchParams.get("count") === "1" ? { countFiles: true } : {}),
    });
    return NextResponse.json({ tree });
  } catch (err) {
    const known = appErrorResponse(err, req);
    if (known) return known;
    log.error(
      { event: "file_tree_failed", outcome: "tree_not_returned", workspaceId: id, source, err },
      "failed to list workspace files",
    );
    return errorResponse("INTERNAL_ERROR", "The workspace files could not be listed", { request: req });
  }
}
