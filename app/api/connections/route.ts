// POST connects two ids, whichever two they are; lib/operations/connections/resolve decides which
// graph the pair belongs to. The per-graph routes stay for the editor, which sends handles and positions.
import { NextResponse, type NextRequest } from "next/server";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { connect } from "@/lib/operations/connections/resolve";

const log = createLogger("api").child({ route: "connections" });

export async function POST(req: NextRequest) {
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(connect(parsed), { status: 201 });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "connection_create_failed", outcome: "connection_not_persisted", code: "INTERNAL_ERROR", err },
      "failed to connect",
    );
    return errorResponse("INTERNAL_ERROR", "failed to connect", { request: req });
  }
}
