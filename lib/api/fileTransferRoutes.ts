// The HTTP shape of the streaming tar transfer, shared by the workspace and drive routes. Everything
// here is transport: frame the archive, hand the body to the operation, and turn the result into a
// status and a body. What a transfer means — the ignore contract, containment, the wire path space,
// size limits and the error vocabulary — is lib/operations/files/transfer.ts.
//
// The browser's ZIP download and per-file upload remain separate UI transports, and that split is
// deliberate rather than unfinished: streaming an archive out of a browser needs fetch request
// streaming, which is not available everywhere, and the browser's upload wants the per-file retry and
// progress that a single request cannot offer. Only the framing differs.
//
// One thing genuinely differs between the two spaces, and it is the reason `versioning` is a parameter
// rather than something this module reaches for: a workspace is versioned, so a push that overwrote a
// tree and left no revision behind is not the operation the caller asked for and fails the call. A
// drive is passive host storage with no history at all, so there is no revision to fail over — the
// caller is told that by `drive rm` being final, not by a snapshot that quietly does nothing. Passing
// no versioning is therefore a statement about the space, not a shortcut.
import { NextResponse } from "next/server";
import { Readable } from "stream";
import { appErrorResponse, errorResponse, requestIdOf, statusForCode } from "@/lib/api/errorResponse";
import { publicErrorBody } from "@/lib/errors/appError";
import { createLogger } from "@/lib/infra/logger";
import type { FileBackend } from "@/lib/files/backend";
import {
  collectTransfer,
  packTransfer,
  putTransfer,
  TRANSFER_MEDIA_TYPE,
  TransferApplyError,
  transferApplyAppError,
  type PutTransferReceipt,
} from "@/lib/operations/files/transfer";

/** How a versioned space records what a push did. Omitted entirely by a space that keeps no history. */
export interface TransferVersioning {
  /**
   * Run once the archive has been staged and validated, before anything is applied. A pending burst
   * from another client is a different user action, so it becomes its own revision rather than being
   * folded into this one.
   */
  beforeApply(): Promise<void>;
  /** Record a revision covering what was applied. `false` means it could not be recorded. */
  commit(receipt: PutTransferReceipt): Promise<boolean>;
}

export function changed(receipt: PutTransferReceipt): number {
  return receipt.created.length + receipt.overwritten.length;
}

export async function getFileTransfer(request: Request, be: FileBackend): Promise<Response> {
  const log = createLogger("api").child(be.logContext);
  const source = new URL(request.url).searchParams.get("path") ?? ".";

  try {
    const items = await collectTransfer(be.dir, source);
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
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error(
      { event: "file_transfer_export_failed", outcome: "transfer_not_exported", err, source },
      "failed to export transfer",
    );
    return errorResponse("INTERNAL_ERROR", "The transfer could not be exported", { request });
  }
}

export async function putFileTransfer(
  request: Request,
  be: FileBackend,
  versioning?: TransferVersioning,
): Promise<Response> {
  const log = createLogger("api").child(be.logContext);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== TRANSFER_MEDIA_TYPE) {
    return errorResponse("INVALID_REQUEST", `Content-Type must be ${TRANSFER_MEDIA_TYPE}`, {
      request,
      details: { field: "content-type" },
    });
  }
  if (!request.body) {
    return errorResponse("INVALID_REQUEST", "A transfer body is required", { request, details: { field: "body" } });
  }

  const dest = new URL(request.url).searchParams.get("dest");
  let receipt: PutTransferReceipt;
  try {
    receipt = await putTransfer(
      be.dir,
      dest,
      Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
      {
        ...(versioning ? { beforeApply: () => versioning.beforeApply() } : {}),
      },
    );
  } catch (err) {
    if (err instanceof TransferApplyError) {
      const operationError = transferApplyAppError(err);
      // Whatever landed before the failure is real and has to be recoverable, so it is committed even
      // though the call is about to fail.
      if (versioning && changed(err.receipt) > 0) await versioning.commit(err.receipt);
      const code = operationError?.code ?? "INTERNAL_ERROR";
      if (!operationError) {
        log.error(
          {
            event: "file_transfer_import_failed",
            outcome: "transfer_partially_applied",
            dest,
            err: err.operationError,
          },
          "failed while applying transfer",
        );
      }
      const body = {
        ...publicErrorBody(code, operationError?.message ?? "The transfer could not be fully applied", {
          details: operationError?.details,
          requestId: requestIdOf(request),
        }),
        ...err.receipt,
      };
      return NextResponse.json(body, { status: statusForCode(code), headers: { "Cache-Control": "no-store" } });
    }

    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error(
      { event: "file_transfer_import_failed", outcome: "transfer_not_applied", dest, err },
      "failed to import transfer",
    );
    return errorResponse("INTERNAL_ERROR", "The transfer could not be imported", { request });
  }

  if (versioning && !(await versioning.commit(receipt))) {
    // The files landed, but there is no revision to undo them with. Worth failing the call over: a
    // push that overwrote a tree and left no way back is not the operation the caller asked for.
    return NextResponse.json(
      {
        ...publicErrorBody("INTERNAL_ERROR", "The transfer was applied but its snapshot could not be created", {
          requestId: requestIdOf(request),
        }),
        ...receipt,
      },
      { status: statusForCode("INTERNAL_ERROR"), headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({ ok: true, ...receipt }, { headers: { "Cache-Control": "no-store" } });
}
