// Streaming tar transport used by the CLI for one file, a directory tree, or the workspace root.
//
// The browser's ZIP download and per-file upload remain separate UI transports, and that split is
// deliberate rather than unfinished: streaming an archive out of a browser needs fetch request
// streaming, which is not available everywhere, and the browser's upload wants the per-file retry and
// progress that a single request cannot offer. What both transports share is everything that decides
// what a transfer means — the ignore contract, containment, the wire path space, size limits, the error
// vocabulary and the git snapshot. Only the framing differs.
//
// A pull is not rate limited; a push spends the same budget as the browser's upload. See PUT below for
// why that is parity rather than a bound.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { rateLimited, requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, requestIdOf, statusForCode } from "@/lib/api/errorResponse";
import { publicErrorBody } from "@/lib/errors/appError";
import { getVersioning } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";
import { flushSnapshotBurstStrict, snapshotWorkspaceStrict } from "@/lib/infra/git/snapshotWorkspace";
import {
  collectTransfer,
  packTransfer,
  putTransfer,
  TRANSFER_MEDIA_TYPE,
  TransferApplyError,
  transferApplyAppError,
  type PutTransferReceipt,
} from "@/lib/operations/files/transfer";

const log = createLogger("api");

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  const source = new URL(req.url).searchParams.get("path") ?? ".";

  try {
    const items = await collectTransfer(ws.dir, source);
    const stream = packTransfer(items);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": TRANSFER_MEDIA_TYPE,
        "Content-Disposition": 'attachment; filename="paodo-transfer.tar"',
        "X-PAODO-Transfer-Version": "1",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const known = appErrorResponse(err, req);
    if (known) return known;
    log.error(
      { event: "file_transfer_export_failed", outcome: "transfer_not_exported", workspaceId: id, source, err },
      "failed to export workspace transfer",
    );
    return errorResponse("INTERNAL_ERROR", "The transfer could not be exported", { request: req });
  }
}

function changed(receipt: PutTransferReceipt): number {
  return receipt.created.length + receipt.overwritten.length;
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
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== TRANSFER_MEDIA_TYPE) {
    return errorResponse("INVALID_REQUEST", `Content-Type must be ${TRANSFER_MEDIA_TYPE}`, {
      request: req,
      details: { field: "content-type" },
    });
  }
  if (!req.body) {
    return errorResponse("INVALID_REQUEST", "A transfer body is required", {
      request: req,
      details: { field: "body" },
    });
  }

  const dest = new URL(req.url).searchParams.get("dest");
  let receipt: PutTransferReceipt;
  try {
    receipt = await putTransfer(
      ws.dir,
      dest,
      Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]),
      {
        // A pending browser-upload burst is a different user action. Commit it only after this
        // archive has passed validation, then apply the transfer and take its own snapshot below.
        beforeApply: async () => {
          await flushSnapshotBurstStrict(getVersioning(), ws);
        },
      },
    );
  } catch (err) {
    if (err instanceof TransferApplyError) {
      const operationError = transferApplyAppError(err);
      if (changed(err.receipt) > 0) await snapshot(id, ws, err.receipt);
      const code = operationError?.code ?? "INTERNAL_ERROR";
      if (!operationError) {
        log.error(
          {
            event: "file_transfer_import_failed",
            outcome: "transfer_partially_applied",
            workspaceId: id,
            dest,
            err: err.operationError,
          },
          "failed while applying workspace transfer",
        );
      }
      const body = {
        ...publicErrorBody(code, operationError?.message ?? "The transfer could not be fully applied", {
          details: operationError?.details,
          requestId: requestIdOf(req),
        }),
        ...err.receipt,
      };
      return NextResponse.json(body, { status: statusForCode(code), headers: { "Cache-Control": "no-store" } });
    }

    const known = appErrorResponse(err, req);
    if (known) return known;
    log.error(
      { event: "file_transfer_import_failed", outcome: "transfer_not_applied", workspaceId: id, dest, err },
      "failed to import workspace transfer",
    );
    return errorResponse("INTERNAL_ERROR", "The transfer could not be imported", { request: req });
  }

  if (!(await snapshot(id, ws, receipt))) {
    // The files landed, but there is no revision to undo them with. Worth failing the call over: a
    // push that overwrote a tree and left no way back is not the operation the caller asked for.
    return NextResponse.json(
      {
        ...publicErrorBody("INTERNAL_ERROR", "The transfer was applied but its snapshot could not be created", {
          requestId: requestIdOf(req),
        }),
        ...receipt,
      },
      { status: statusForCode("INTERNAL_ERROR"), headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({ ok: true, ...receipt }, { headers: { "Cache-Control": "no-store" } });
}
