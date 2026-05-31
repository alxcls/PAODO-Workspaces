// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";
const securityLogFile = process.env.SECURITY_LOG_FILE;
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

// Dev: pipe directly to pino-pretty (no worker_threads) to avoid EBADF errors on hot-reload.
// Production: use pino transport API which correctly handles pretty printing via worker_threads.
const root = isDev
  ? pino({ level }, pinoPretty({ colorize: true, singleLine: true }))
  : pino({
      level,
      transport: {
        targets: [
          { target: "pino-pretty", options: { colorize: true, singleLine: true }, level },
          ...(securityLogFile
            ? [{ target: "pino/file", options: { destination: securityLogFile }, level: "warn" }]
            : []),
        ],
      },
    });

export function createLogger(context: string) {
  return root.child({ context });
}

export const logger = createLogger("app");
