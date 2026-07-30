// Shared pino logger. Call createLogger(context) for a child scoped to a module, or
// createAuditLogger(context) for one whose lines are tagged as security events.
//
// Everything goes to stdout as JSON and nothing is written to disk. Docker's json-file driver
// (docker-compose.yml) already captures, caps and rotates stdout, so a durable log file would mean
// re-implementing all of that — a dir to pre-create, container uid ownership, logrotate, and a flush
// on every exit path — for a file nobody reads. `docker logs paodo_ws-app-1` is the log.
//
// Node builtins are imported by bare specifier, not with the `node:` prefix. instrumentation.node.ts
// reaches this module, so Next compiles it with webpack, and webpack rejects `node:`-scheme builtins
// in that entry ("Unhandled scheme") — which failed every dev-server request with a 500.
import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

// Routine records are buffered and drained asynchronously so Docker stdout backpressure cannot
// block the Node.js event loop on every request. The cap prevents a stalled Docker log reader from
// turning the buffer into unbounded process memory; SonicBoom drops new records after the cap and
// resumes once the destination drains. Fatal calls synchronously drain the existing buffer before
// enqueueing their record, and exitAfterLogs() drains that final record immediately before exit.
const destination = pino.destination({
  fd: 1,
  sync: false,
  // Keep even unusually large fatal records buffered until exitAfterLogs can drain them in one
  // synchronous boundary write. A short periodic flush still makes routine records visible fast.
  minLength: 512 * 1024,
  maxWrite: 1024 * 1024,
  periodicFlush: 100,
  maxLength: 8 * 1024 * 1024,
});

type LogContext = Record<string, unknown>;

// Field-name redaction below protects structured bindings, but credentials also turn up inside
// strings: provider errors echo an API key, command stderr contains an authenticated URL, or an
// Error stack repeats its message. Keep those diagnostics while replacing the credential-shaped
// portion. These patterns deliberately require an auth label or a well-known token prefix; broad
// "long string" matching would destroy hashes, workspace ids, and other useful context.
const credentialPatterns: Array<[RegExp, string]> = [
  [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[Redacted Private Key]",
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._:~-]+/gi, "$1 [Redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+@/gi, "$1[Redacted]@"],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1[Redacted]"],
  [
    /\b(?:(?:sk-(?:proj-|ant-)?|sk_|github_pat_|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9._-]{8,}|(?:mcp|cli)_[A-Za-z0-9._-]{32,})\b/g,
    "[Redacted]",
  ],
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[Redacted]",
  ],
];

function sanitizeLogText(value: string): string {
  return credentialPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function sanitizeError(value: unknown): unknown {
  const serialized = pino.stdSerializers.err(value as Error);
  if (typeof serialized === "string") return sanitizeLogText(serialized);
  if (serialized === null || typeof serialized !== "object") return serialized;

  // pino-std-serializers returns an ErrorLike object with a custom prototype, so handle its public
  // fields explicitly instead of sending it through the plain-object guard below. Object.entries
  // intentionally omits Pino's raw-error symbol, which points back to the unsanitized Error.
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(serialized)) copy[key] = sanitizeLogValue(item);
  return copy;
}

function sanitizeLogValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return sanitizeLogText(value);
  // `err` gets an explicit serializer below. Leaving Error instances intact here prevents Pino's
  // built-in serializer from following its raw-error symbol back to the unsanitized original.
  if (value instanceof Error) return value;
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeLogValue(item, seen));
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = sanitizeLogValue(item, seen);
  return copy;
}

const defaultOutcomes: Record<number, string> = {
  10: "diagnostic_recorded",
  20: "diagnostic_recorded",
  30: "event_recorded",
  40: "attention_required",
  50: "operation_failed",
  60: "process_exit",
};

/** Turn a human message into the stable fallback event used by legacy call sites. */
function eventFromMessage(message: string | undefined, level: number): string {
  const event = (message ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96)
    .replace(/_+$/g, "");
  if (!event) return `log_level_${level}`;
  return /^[a-z]/.test(event) ? event : `log_${event}`;
}

/**
 * Ensure every emitted record has the same query contract.
 *
 * Error/fatal call sites still carry explicit, semantic event/outcome pairs (enforced by
 * errorLogContract.test.ts). Existing explicit fields at any level always win. The fallback keeps
 * older info/warn/debug calls queryable immediately; those call sites can be promoted to more
 * specific semantic outcomes over time without changing the wire shape.
 */
function applyLogContract(args: unknown[], level: number): unknown[] {
  const message = args.find((arg): arg is string => typeof arg === "string");
  const defaults = {
    event: eventFromMessage(message, level),
    outcome: defaultOutcomes[level] ?? "event_recorded",
  };
  const first = args[0];
  if (first !== null && typeof first === "object" && !Array.isArray(first) && !(first instanceof Error)) {
    return [{ ...defaults, ...(first as Record<string, unknown>) }, ...args.slice(1)];
  }
  return [defaults, ...args];
}

// The custom server and Next.js route bundles can evaluate this module separately while sharing
// one Node.js global. Keep the AsyncLocalStorage there so every logger instance sees the request
// context established at the HTTP boundary.
const g = globalThis as typeof globalThis & { _paodoLogContext?: AsyncLocalStorage<LogContext> };
const logContext = (g._paodoLogContext ??= new AsyncLocalStorage<LogContext>());

const root = pino(
  {
    level,
    // The credential proxy means third-party API keys pass through this process. A token reaching a
    // log line is a real leak, so redaction stays even though everything else here got cut.
    redact: {
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
      censor: "[Redacted]",
    },
    serializers: {
      err(value: unknown) {
        return sanitizeError(value);
      },
    },
    hooks: {
      // Sanitize both bindings and the message itself before Pino serializes them. In particular,
      // Error.message and Error.stack are non-enumerable, so the explicit `err` serializer above
      // first runs Pino's standard Error serializer and then scrubs the resulting strings.
      logMethod(args, method, level) {
        // Make room for a fatal record in the bounded async buffer. This is intentionally the only
        // log level that may block; callers use it when the process is already about to terminate.
        if (level === 60) {
          try {
            destination.flushSync();
          } catch {
            // Best effort: Pino will still attempt to enqueue the fatal record below. The eventual
            // exit must not be prevented just because stdout itself is broken.
          }
        }
        const sanitized = args.map((arg) => sanitizeLogValue(arg));
        method.apply(this, applyLogContract(sanitized, level) as Parameters<typeof method>);
      },
    },
    // Pino may mutate the object returned by mixin, so never hand it the stored object directly.
    mixin: () => ({ ...(logContext.getStore() ?? {}) }),
  },
  // Plain JSON on stdout in every environment. Pretty-printing is deliberately not wired in here:
  // pino-pretty pulls node:stream through pino-abstract-transport, and because this module is
  // reachable from instrumentation.ts, Next tries to bundle it and the dev server fails every
  // request with "Can't resolve 'stream'". Pipe through `npm run dev | npx pino-pretty` instead.
  //
  destination,
);

export function createLogger(context: string) {
  return root.child({ context });
}

/**
 * Logger for security events — auth failures, rate limits, credential access. Same stream as
 * everything else; the `audit: true` tag is what separates them, so filtering is
 * `docker logs paodo_ws-app-1 | jq 'select(.audit)'`.
 *
 * Note this means LOG_LEVEL applies to audit events too: setting it above `info` will silence the
 * low-severity ones (an API-key rotation) while leaving the warnings. That is the accepted cost of
 * one stream instead of two.
 */
export function createAuditLogger(context: string) {
  return root.child({ context, audit: true });
}

/** Run work with structured fields automatically attached to every log line it produces. */
export function runWithLogContext<T>(bindings: LogContext, fn: () => T): T {
  return logContext.run(bindings, fn);
}

/** Drain buffered records synchronously. Reserved for tests and intentional process shutdown. */
export function flushLogsSync(): void {
  destination.flushSync();
}

/** Flush the final log records and terminate even if stdout itself cannot be drained. */
export function exitAfterLogs(code: number): never {
  try {
    flushLogsSync();
  } finally {
    process.exit(code);
  }
}
