// Shared pino logger factory. Call createLogger(context) to get a child logger
// scoped to a module; use the exported `logger` singleton for app-level messages.
//
// Node builtins are imported by bare specifier, not with the `node:` prefix. instrumentation.node.ts
// reaches this module, so Next compiles it with webpack, and webpack rejects `node:`-scheme builtins
// in that entry ("Unhandled scheme") — which failed every dev-server request with a 500.
import { chmodSync, mkdirSync, openSync } from "fs";
import { AsyncLocalStorage } from "async_hooks";
import path from "path";
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const operationalLogFile = process.env.OPERATIONAL_LOG_FILE;
const securityLogFile = process.env.SECURITY_LOG_FILE;
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

const REDACTED = "[Redacted]";
type LogContext = Record<string, unknown>;

// The custom server and Next.js route bundles can evaluate this module separately while sharing
// one Node.js global. Keep the AsyncLocalStorage there so every logger instance sees the request
// context established at the HTTP boundary.
const g = globalThis as typeof globalThis & { _paodoLogContext?: AsyncLocalStorage<LogContext> };
const logContext = (g._paodoLogContext ??= new AsyncLocalStorage<LogContext>());
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

// Every durable destination we open, so a shutdown can flush them before the process goes away.
const durableDestinations: pino.DestinationStream[] = [];

/**
 * Flush buffered log lines to disk. Writes are buffered rather than synchronous (see
 * durableDestination), so the exit paths in server.ts call this to make sure the last few lines —
 * usually the very ones explaining why the process is exiting — actually reach the file.
 */
export function flushLogs(): void {
  for (const destination of durableDestinations) {
    (destination as { flushSync?: () => void }).flushSync?.();
  }
}

function durableDestination(filePath: string) {
  const directory = path.dirname(filePath);

  try {
    mkdirSync(directory, { recursive: true, mode: 0o750 });
    const fd = openSync(filePath, "a", 0o600);
    chmodSync(filePath, 0o600);
    // Buffered, not synchronous. A synchronous write per line puts disk I/O directly on the event
    // loop, which means anyone able to provoke a warning — an unauthenticated request that gets a
    // 401 counts — can stall the server. Buffered writes cost nothing on the hot path; flushLogs()
    // covers the exit paths so a clean shutdown still loses nothing.
    const destination = pino.destination({ dest: fd, sync: false });
    durableDestinations.push(destination);
    return destination;
  } catch (err) {
    console.error(`Cannot open durable log file ${filePath}`, err);
    throw err;
  }
}

// Repeated warnings collapse into one line plus a count of what it stood in for.
//
// This lives here rather than at the call sites because the reasons to want it are all the same
// reason: a hot retry loop, or a scanner walking the login endpoint, turning one real event into
// thousands of identical lines. Left alone that buries the events worth reading and can push older
// entries out of the rotation window entirely. Warn and above only — info and below are low-volume
// or development-only, and silently dropping them would just be confusing.
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MIN_LEVEL = 40;
const recentWarnings = new Map<string, { emittedAt: number; suppressed: number }>();

function dedupeDecision(key: string, now: number): { emit: false } | { emit: true; suppressed: number } {
  const seen = recentWarnings.get(key);
  if (!seen) {
    recentWarnings.set(key, { emittedAt: now, suppressed: 0 });
    return { emit: true, suppressed: 0 };
  }
  if (now - seen.emittedAt < DEDUPE_WINDOW_MS) {
    seen.suppressed += 1;
    return { emit: false };
  }
  const { suppressed } = seen;
  seen.emittedAt = now;
  seen.suppressed = 0;
  return { emit: true, suppressed };
}

// Deliberately coarse: the message plus the event/status discriminators, never the client address or
// a route parameter. Keying on those would let a scanner spread across addresses defeat the whole
// mechanism, which is the case this exists for.
const dedupeHook: pino.LoggerOptions["hooks"] = {
  logMethod(args, method, level) {
    if (level < DEDUPE_MIN_LEVEL) return method.apply(this, args);

    const [first, second] = args;
    const fields = typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
    const message = typeof first === "string" ? first : typeof second === "string" ? second : "";
    const key = `${level}|${message}|${fields?.event ?? ""}|${fields?.status ?? ""}`;

    const decision = dedupeDecision(key, Date.now());
    if (!decision.emit) return;
    if (decision.suppressed === 0) return method.apply(this, args);

    // Report the true volume the surviving line stands for.
    const annotated = { ...(fields ?? {}), suppressed: decision.suppressed };
    return method.call(this, annotated, message);
  },
};

function buildRoot(rootLevel: string, durableFile: string | undefined, durableLevel: "info" | "warn") {
  // Always plain JSON on stdout, in every environment. Pretty-printing used to be wired in here for
  // development, which cost more than it was worth: pino-pretty pulls node:stream through
  // pino-abstract-transport, and because this module is reachable from instrumentation.ts, Next
  // tried to bundle it and the dev server failed every request with "Can't resolve 'stream'". It
  // also meant production logs carried ANSI escapes, which is both unreadable through `docker logs`
  // and a way for attacker-influenced text to smuggle terminal control sequences into a maintainer's
  // shell. `npm run dev | npx pino-pretty` gives the same colours back when you want them.
  const streams: pino.StreamEntry[] = [{ level: rootLevel as pino.Level, stream: process.stdout }];
  // Durable files are driven purely by configuration. Tying this to NODE_ENV as well would mean a
  // stray environment silently produces an app with no audit trail and no complaint.
  if (durableFile) streams.push({ level: durableLevel, stream: durableDestination(durableFile) });
  return pino(
    {
      level: rootLevel,
      redact,
      hooks: dedupeHook,
      // Pino may mutate the object returned by mixin, so never hand it the stored object directly.
      mixin: () => ({ ...(logContext.getStore() ?? {}) }),
    },
    pino.multistream(streams),
  );
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

/** Run work with structured fields automatically attached to every operational and audit log. */
export function runWithLogContext<T>(bindings: LogContext, fn: () => T): T {
  return logContext.run(bindings, fn);
}

export const logger = createLogger("app");
