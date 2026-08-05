// The one failure kind a schedule operation raises, in its own module so the entity and the store can
// be imported without dragging the use case in — and so adapters have a single place to learn this
// layer's error vocabulary. Mirrors lib/operations/workspace/errors.ts.
import { AppError, type ErrorDetails } from "@/lib/errors/appError";

/** A caller error that adapters translate into their transport's invalid-input response. */
export class ScheduleInvalidError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("SCHEDULE_INVALID", message, details);
    this.name = "ScheduleInvalidError";
  }
}
