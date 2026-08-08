// One browser-side representation of the public API error envelope. Consumers may display `error`,
// branch on `code`, and include `requestId` in support diagnostics without reparsing a Response.
export interface ApiFailure {
  ok: false;
  code: string;
  error: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

/** Parse defensively so a proxy HTML page cannot hide the original HTTP failure. */
export async function readApiError(res: Response, fallback: string): Promise<ApiFailure> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // The fallback below is the useful diagnostic for non-JSON intermediaries.
  }

  const headerRequestId = res.headers.get("x-request-id")?.trim() || undefined;
  return {
    ok: false,
    code:
      typeof body.code === "string" && body.code
        ? body.code
        : (CODE_BY_STATUS[res.status] ?? `HTTP_${res.status || "ERROR"}`),
    error: typeof body.error === "string" && body.error ? body.error : fallback,
    ...(body.details && typeof body.details === "object" && !Array.isArray(body.details)
      ? { details: body.details as Record<string, unknown> }
      : {}),
    ...(typeof body.requestId === "string" && body.requestId
      ? { requestId: body.requestId }
      : headerRequestId
        ? { requestId: headerRequestId }
        : {}),
  };
}

/** Outcome of a mutation whose failure message is shown inline (create/rename forms stay open so
 *  the user can correct the input), rather than thrown. */
export type MutationResult = { ok: true } | ApiFailure;
