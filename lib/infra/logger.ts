// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
import { closeSync, mkdirSync, openSync } from "fs";
import path from "path";
import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

function resolveSecurityLogFile(): string | undefined {
  const f = process.env.SECURITY_LOG_FILE;
  if (!f) return undefined;
  try {
    mkdirSync(path.dirname(f), { recursive: true });
    closeSync(openSync(f, "a"));
    return f;
  } catch {
    console.warn("[logger] Cannot write to security log — file transport disabled");
    return undefined;
  }
}
const securityLogFile = resolveSecurityLogFile();

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
