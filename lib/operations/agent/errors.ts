import { AppError, type ErrorDetails } from "@/lib/errors/appError";

/** A caller supplied no usable prompt for a workspace run. */
export class RunInputInvalidError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("INVALID_REQUEST", message, details);
    this.name = "RunInputInvalidError";
  }
}

/** The requested conversation does not exist in the workspace. */
export class ConversationNotFoundError extends AppError {
  constructor(conversationId: string, details?: ErrorDetails) {
    super("NOT_FOUND", `conversation ${conversationId} not found`, details);
    this.name = "ConversationNotFoundError";
  }
}
