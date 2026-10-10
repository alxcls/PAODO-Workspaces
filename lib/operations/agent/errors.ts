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

/** The requested session does not exist in the conversation. */
export class SessionNotFoundError extends AppError {
  constructor(sessionId: string, details?: ErrorDetails) {
    super("NOT_FOUND", `session ${sessionId} not found`, details);
    this.name = "SessionNotFoundError";
  }
}

/** The requested tool call does not exist in the session. */
export class CallNotFoundError extends AppError {
  constructor(callId: string, details?: ErrorDetails) {
    super("NOT_FOUND", `call ${callId} not found`, details);
    this.name = "CallNotFoundError";
  }
}
