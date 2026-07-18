// Shared pino logger. Call createLogger(context) for a child scoped to a module; use the exported
// `logger` singleton for app-level messages.
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

type LogContext = Record<string, unknown>;

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
    // Pino may mutate the object returned by mixin, so never hand it the stored object directly.
    mixin: () => ({ ...(logContext.getStore() ?? {}) }),
  },
  // Plain JSON on stdout in every environment. Pretty-printing is deliberately not wired in here:
  // pino-pretty pulls node:stream through pino-abstract-transport, and because this module is
  // reachable from instrumentation.ts, Next tries to bundle it and the dev server fails every
  // request with "Can't resolve 'stream'". Pipe through `npm run dev | npx pino-pretty` instead.
  //
  // Writing to process.stdout rather than pino's own fd-1 destination keeps writes synchronous on
  // Linux pipes — which is what a container's stdout is — so a fatal error's last lines are on
  // their way out before process.exit, with no flush plumbing to maintain.
  process.stdout,
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
