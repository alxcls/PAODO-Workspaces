import type { createAuditLogger } from "../logger";
import { throttleLog } from "../logThrottle";

export type AuditLogger = ReturnType<typeof createAuditLogger>;

/**
 * Writes one throttled audit line for a pre-auth rejection. An unauthenticated caller drives how
 * often these fire, and the window is shared by the HTTP and /ws gates: one flood, one line.
 */
export function auditThrottled(audit: AuditLogger, event: string, fields: Record<string, unknown>, msg: string): void {
  const suppressed = throttleLog(event);
  if (suppressed !== null) audit.warn({ ...fields, event, suppressed }, msg);
}
