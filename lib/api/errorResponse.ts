// The shared JSON error boundary for UI, CLI and any later HTTP client. Domain code throws AppError;
// routes use this module to assign transport status without teaching the domain about HTTP.
import { NextResponse } from "next/server";
import {
  AppError,
  publicErrorBody,
  type AppErrorCode,
  type ErrorDetails,
  type PublicErrorBody,
} from "@/lib/errors/appError";

export type ApiErrorBody = PublicErrorBody;

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  WORKSPACE_NAME_INVALID: 400,
  WORKSPACE_NAME_CONFLICT: 409,
  WORKSPACE_UPDATE_INVALID: 400,
  WORKSPACE_UPDATE_FAILED: 500,
  SCHEDULE_INVALID: 400,
  CREDENTIAL_ALREADY_CONFIGURED: 409,
  CREDENTIAL_NOT_CONFIGURED: 409,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

interface ErrorResponseOptions {
  request?: Request;
  requestId?: string;
  details?: ErrorDetails;
  headers?: HeadersInit;
}

function requestId(request?: Request): string | undefined {
  return request?.headers.get("x-request-id")?.trim() || undefined;
}

export function errorResponse(
  code: AppErrorCode,
  error: string,
  { request, requestId: explicitRequestId, details, headers }: ErrorResponseOptions = {},
): NextResponse<ApiErrorBody> {
  const id = explicitRequestId?.trim() || requestId(request);
  return NextResponse.json(publicErrorBody(code, error, { details, requestId: id }), {
    status: STATUS_BY_CODE[code],
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/** Returns null for an unexpected exception so the route can log it once before returning a 500. */
export function appErrorResponse(error: unknown, request?: Request): NextResponse<ApiErrorBody> | null {
  if (!(error instanceof AppError)) return null;
  return errorResponse(error.code, error.message, { request, details: error.details });
}

// A route's unexpected-failure branch is deliberately NOT factored out to sit alongside this. It
// would have to make the log call, and errorLogContract.test.ts requires `event` and `outcome` to be
// string literals at the site that emits them — so an operator can grep an event name straight to
// the code that raises it. Every catch block therefore spells out its own two branches: the expected
// AppError through appErrorResponse, then one literal log record and an opaque 500.

/** Read the object-shaped JSON body expected by mutation routes, with the public failure contract. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | NextResponse<ApiErrorBody>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Invalid JSON", { request });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("INVALID_REQUEST", "JSON body must be an object", { request });
  }
  return body as Record<string, unknown>;
}
