// The HTTP shape of the file-tree endpoint, shared by the workspace and drive routes. Everything here
// is transport: read the query string, call the operation, and turn the result into a status and a
// body. The rules live in lib/operations/files/listing.ts.
//
// Shared for the reason lib/api/fileContentRoutes.ts is: a drive and a workspace are two directories
// behind the same file surface, and a listing that answered `?depth=` on one and ignored it on the
// other is not a second implementation so much as a route the CLI cannot navigate. The one thing that
// differs between them — which directory, and which id appears in a log line — is the FileBackend.
//
// Paths in and out are root-relative (lib/files/relpath.ts). A client names "src/main.ts"; the host
// directory never appears in a request or a response.
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse } from "@/lib/api/errorResponse";
import { AppError } from "@/lib/errors/appError";
import type { FileBackend } from "@/lib/files/backend";
import { listEntries } from "@/lib/operations/files/listing";

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
 * A depth this cannot read is refused rather than rounded to the default: a listing is what a caller
 * decides what to read or delete from next, and quietly answering with a different tree than the one
 * asked for leaves nothing in the response to say so.
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

/**
 * `?limit=`, the most entries any one directory may contribute: a positive integer, or absent for no
 * ceiling at all — which is what the file panel asks for, and what every caller got before this
 * existed.
 *
 * Refused rather than rounded, for the reason `?depth=` is: a listing is what a caller decides what to
 * read or delete from next, and quietly answering with a different set than the one asked for leaves
 * nothing in the response to say so.
 */
function requestedLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const entries = Number(value);
  if (!Number.isInteger(entries) || entries < 1) {
    throw new AppError("INVALID_REQUEST", `limit must be a positive integer, got "${value}"`, { field: "limit" });
  }
  return entries;
}

export async function getFileTree(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
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
    // with the same shape: a one-level listing has to walk everything below it to answer, which is a cost
    // the panel must not pay for a number it does not render. The caller it is for is the one deciding
    // where to look next, and cannot see from a tree alone which directory is enormous.
    const limit = requestedLimit(searchParams.get("limit"));
    const { tree, truncated } = await listEntries(be.dir, source, {
      ...(depth === undefined ? {} : { maxDepth: depth }),
      ...(limit === undefined ? {} : { maxEntries: limit }),
      ...(searchParams.get("measure") === "1" ? { measure: true } : {}),
      ...(searchParams.get("count") === "1" ? { countFiles: true } : {}),
    });
    // `truncated` only when it is true. A caller that set no ?limit= can never see it, and one that did
    // reads a key that is present exactly when it means something — the shape this route already chose
    // when it stopped serving a `truncated` that merely restated the caller's own ?depth=.
    return NextResponse.json({ tree, ...(truncated ? { truncated: true } : {}) });
  } catch (err) {
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error({ event: "file_tree_failed", outcome: "tree_not_returned", err, source }, "failed to list files");
    return errorResponse("INTERNAL_ERROR", "The files could not be listed", { request });
  }
}
