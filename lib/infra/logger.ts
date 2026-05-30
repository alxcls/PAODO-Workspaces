// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";
const securityLogFile = process.env.SECURITY_LOG_FILE;

// In dev, pipe directly to pino-pretty (no worker_threads spawn) to avoid
// EBADF errors when Next.js hot-reloads this module during high-concurrency requests.
// In production, if SECURITY_LOG_FILE is set, fan out: stdout gets all logs and the
// file gets warn+ only (the security-relevant tier that fail2ban watches).
const root = isDev
  ? pino(
      { level: process.env.LOG_LEVEL ?? "debug" },
      pinoPretty({ colorize: true, singleLine: true })
    )
  : securityLogFile
  ? pino(
      { level: process.env.LOG_LEVEL ?? "info" },
      pino.multistream([
        { stream: process.stdout },
        { stream: pino.destination(securityLogFile), level: "warn" },
      ])
    )
  : pino({ level: process.env.LOG_LEVEL ?? "info" });

export function createLogger(context: string) {
  return root.child({ context });
}

export const logger = createLogger("app");
