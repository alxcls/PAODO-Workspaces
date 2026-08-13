// Stable failures that may cross an application boundary. Codes are for programs; messages are for
// people. Once published, a code keeps its meaning even when its wording improves.
export const ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  /** The request was valid but lost a race — the thing it named changed underneath it. */
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  /** The instance-wide active-agent fuse is full. The request is safe to retry after a run ends. */
  CAPACITY_REACHED: "CAPACITY_REACHED",
  /**
   * The filesystem refused the write. Deliberately not FORBIDDEN: 403 already means CSRF rejection in
   * this app (server.ts), so a read-only file answering 403 would be indistinguishable from "this
   * request was not allowed to be made" in a log or to a CLI author reading a status.
   */
  FILE_NOT_WRITABLE: "FILE_NOT_WRITABLE",
  /** Over MAX_UPLOAD_BYTES, which is our own policy — hence FILE_, not the 413 status name. */
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  /**
   * One transfer carried too many entries or too many bytes in total, though no single file was over
   * the limit. Deliberately not FILE_TOO_LARGE: a caller that is told one file is too big drops or
   * splits that file, while a caller told the transfer is too big has to split the transfer.
   */
  TRANSFER_TOO_LARGE: "TRANSFER_TOO_LARGE",
  STORAGE_EXHAUSTED: "STORAGE_EXHAUSTED",
  WORKSPACE_NAME_INVALID: "WORKSPACE_NAME_INVALID",
  WORKSPACE_NAME_CONFLICT: "WORKSPACE_NAME_CONFLICT",
  WORKSPACE_UPDATE_INVALID: "WORKSPACE_UPDATE_INVALID",
  WORKSPACE_UPDATE_FAILED: "WORKSPACE_UPDATE_FAILED",
  /**
   * A third-party secret was offered to a route that does not write secrets. Its own code rather than
   * FORBIDDEN or INVALID_REQUEST: "unknown field" would invite a caller to retry with a better
   * spelling, and a bare 403 is this app's CSRF rejection (server.ts) — neither tells a program that
   * the field exists, is refused here on purpose, and has one endpoint of its own.
   */
  WORKSPACE_SECRET_FORBIDDEN: "WORKSPACE_SECRET_FORBIDDEN",
  SCHEDULE_INVALID: "SCHEDULE_INVALID",
  CREDENTIAL_ALREADY_CONFIGURED: "CREDENTIAL_ALREADY_CONFIGURED",
  CREDENTIAL_NOT_CONFIGURED: "CREDENTIAL_NOT_CONFIGURED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type AppErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type ErrorDetails = Record<string, unknown>;

export interface PublicErrorBody {
  ok: false;
  code: AppErrorCode;
  error: string;
  details?: ErrorDetails;
  requestId?: string;
}

/** Pure wire-envelope builder, also usable by the custom HTTP server before Next.js is entered. */
export function publicErrorBody(
  code: AppErrorCode,
  error: string,
  options: { details?: ErrorDetails; requestId?: string } = {},
): PublicErrorBody {
  return {
    ok: false,
    code,
    error,
    ...(options.details ? { details: options.details } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
}

/** A safe, expected application failure. Its cause stays private; adapters may expose these fields. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * A present value that must be a string. Callers with their own error type (e.g. a capability-specific
 * AppError subclass) pass `fail` instead of taking the default INVALID_REQUEST.
 */
export function requireString(
  value: unknown,
  field: string,
  fail: (message: string) => Error = (message) => new AppError("INVALID_REQUEST", message, { field }),
): string {
  if (typeof value !== "string") throw fail(`${field} must be a string`);
  return value;
}

/**
 * A present value that must be a non-empty (post-trim) string — the common "id"/"name is required"
 * guard. A non-string is refused rather than coerced: every field this guards is an opaque key or
 * label, so `String(value)` would turn a wrong-typed field into a lookup that reports "not found"
 * instead of "bad request".
 */
export function requireNonEmptyString(
  value: unknown,
  field: string,
  fail: (message: string) => Error = (message) => new AppError("INVALID_REQUEST", message, { field }),
): string {
  if (typeof value !== "string" || !value.trim()) throw fail(`${field} is required`);
  return value;
}
