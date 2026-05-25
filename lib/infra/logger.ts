// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";

// In dev, pipe directly to pino-pretty (no worker_threads spawn) to avoid
// EBADF errors when Next.js hot-reloads this module during high-concurrency requests.
const root = isDev
  ? pino(
      { level: process.env.LOG_LEVEL ?? "debug" },
      pinoPretty({ colorize: true, singleLine: true })
    )
  : pino({ level: process.env.LOG_LEVEL ?? "info" });

export function createLogger(context: string) {
  return root.child({ context });
}

export const logger = createLogger("app");
