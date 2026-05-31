# ADR — Global object for cross-reload state persistence

Status: Accepted

## Context

Next.js dev mode re-evaluates module files on every hot-reload. A module-level `Map` or singleton would be reset on each file save, dropping live WebSocket connections and in-memory workspace/API-key state mid-session.

## Decision

Store WebSocket connections (`wsHub.ts`), workspace registry (`workspaceStore.ts`), and API key store (`apiKeyStore.ts`) on the Node.js `global` object, falling back to initialization only when the key is absent:

```ts
const g = global as typeof global & { _wsConnections?: Map<string, Set<WebSocket>> };
if (!g._wsConnections) g._wsConnections = new Map();
```

The Node.js `global` object is not re-evaluated between hot-reloads, so the data survives module replacement.

## Consequences

- Live WebSocket connections and session state persist across dev-mode reloads.
- Global keys must be namespaced carefully to avoid collisions with other libraries.
- The pattern is also load-bearing in production for `workspaceStore.ts`: the custom server (`server.ts`) and the webpack-bundled API routes run as separate module instances, so without the global they each get their own `Map` and workspaces created via the API are invisible to the WebSocket handler.

## Alternatives considered

- Module-level singletons: simple but reset on every hot-reload, breaking active sessions.
- External process (Redis, SQLite) for live state: durable but heavy for a self-hosted single-process app.
