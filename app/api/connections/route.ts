// GET lists connections of both kinds, whole or `?for=<id>`; POST connects two ids, whichever two they
// are. The per-graph routes stay for the editor, which sends handles and positions.
import { NextResponse, type NextRequest } from "next/server";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { connectionListing } from "@/lib/operations/connections/list";
import { connect } from "@/lib/operations/connections/resolve";

const log = createLogger("api").child({ route: "connections" });

export function GET(req: NextRequest) {
  try {
    return NextResponse.json(connectionListing(req.nextUrl.searchParams.get("for") ?? undefined));
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "connection_list_failed", outcome: "connections_not_listed", code: "INTERNAL_ERROR", err },
      "failed to list connections",
    );
    return errorResponse("INTERNAL_ERROR", "failed to list connections", { request: req });
  }
}

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
