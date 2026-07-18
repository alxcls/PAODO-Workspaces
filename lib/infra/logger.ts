// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
import { chmodSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import pinoPretty from "pino-pretty";

const isDev = process.env.NODE_ENV !== "production";
const operationalLogFile = process.env.OPERATIONAL_LOG_FILE;
const securityLogFile = process.env.SECURITY_LOG_FILE;
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

const pretty = pinoPretty({ colorize: true, singleLine: true });
const REDACTED = "[Redacted]";
const redact = {
  paths: [
    "password",
    "token",
    "secret",
    "apiKey",
    "authorization",
    "headers.authorization",
    "req.headers.authorization",
    "*.password",
    "*.token",
    "*.secret",
    "*.apiKey",
    "*.authorization",
  ],
  censor: REDACTED,
};

function durableDestination(filePath: string) {
  const directory = path.dirname(filePath);

  try {
    mkdirSync(directory, { recursive: true, mode: 0o750 });
    const fd = openSync(filePath, "a", 0o600);
    chmodSync(filePath, 0o600);
    return pino.destination({ dest: fd, sync: true });
  } catch (err) {
    console.error(`Cannot open durable log file ${filePath}`, err);
    throw err;
  }
}

function buildRoot(rootLevel: string, durableFile: string | undefined, durableLevel: "info" | "warn") {
  const streams: pino.StreamEntry[] = [{ level: rootLevel as pino.Level, stream: pretty }];
  if (!isDev && durableFile) streams.push({ level: durableLevel, stream: durableDestination(durableFile) });
  return pino({ level: rootLevel, redact }, pino.multistream(streams));
}

// Operational warnings/errors and security audit events deliberately use separate roots and files.
// Severity is not an audit classification: an API-key rotation is an info-level success but still
// belongs in the security trail, while a failed file read is operational rather than an audit event.
const root = buildRoot(level, operationalLogFile, "warn");
const auditRoot = buildRoot(isDev ? "debug" : "info", securityLogFile, "info");

export function createLogger(context: string) {
  return root.child({ context });
}

export function createAuditLogger(context: string) {
  return auditRoot.child({ context, audit: true });
}

export const logger = createLogger("app");
