// DELETE removes one connection of either kind; the id itself says which graph holds it.
import { NextResponse, type NextRequest } from "next/server";
import { appErrorResponse, errorResponse } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { disconnect } from "@/lib/operations/connections/resolve";

const log = createLogger("api").child({ route: "connections" });

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(disconnect(id));
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "connection_remove_failed", outcome: "connection_not_removed", code: "INTERNAL_ERROR", err },
      "failed to disconnect",
    );
    return errorResponse("INTERNAL_ERROR", "failed to disconnect", { request: req });
  }
}
