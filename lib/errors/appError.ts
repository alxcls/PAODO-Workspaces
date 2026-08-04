// Stable failures that may cross an application boundary. Codes are for programs; messages are for
// people. Once published, a code keeps its meaning even when its wording improves.
export const ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  WORKSPACE_NAME_INVALID: "WORKSPACE_NAME_INVALID",
  WORKSPACE_NAME_CONFLICT: "WORKSPACE_NAME_CONFLICT",
  WORKSPACE_UPDATE_INVALID: "WORKSPACE_UPDATE_INVALID",
  WORKSPACE_UPDATE_FAILED: "WORKSPACE_UPDATE_FAILED",
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
