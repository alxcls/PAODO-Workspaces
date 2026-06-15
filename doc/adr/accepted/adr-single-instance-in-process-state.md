# ADR — Single-instance, in-process coordination state

Status: Accepted

## Context

The app keeps its live coordination state in the memory of one Node.js process (attached to the `global` object so it survives Next.js hot-reload — see `adr-global-object-hot-reload-survival.md`). Slow-changing data is mirrored to disk as JSON, but the *live* state is process-local and has no shared backing store:

- workspace conversation history — `global._workspaces` (`workspaceStore.ts`); only the registry metadata is persisted to `.workspaces.json`, the live `messages` arrays are memory-only
- API-key cache — `global._apiKeys` (`apiKeyStore.ts`), loaded from disk once at boot
- open WebSocket connections — `wsHub.ts`
- container idle timers and start-coalescing locks — `idleTimers` / `startLocks` on the `ContainerManager` singleton (`containerManager.ts`)
- per-workspace todos — `todoStore.ts`
- auth-failure / rate-limit counters — `server.ts`, `rateLimit.ts`

The deployment target is a single Linux VPS (one process). This ADR records that the single-process assumption is **intentional**, so it isn't mistaken for an oversight later.

## Decision

The app is **single-instance by design and scales vertically only.** Coordination state lives in process memory; we do not run multiple replicas behind a load balancer. Docker is host-local, so each workspace container is owned by the one process on its host.

Running 2+ instances is explicitly out of scope. Doing so safely would require externalizing state first (see Consequences).

## Consequences

- **Enables:** a simple, low-latency, easy-to-self-host architecture with no Redis/DB dependency for live state; container start-coalescing and idle-timeout logic that is correct because exactly one process owns each container.
- **Costs / ceiling:** the only path to more capacity is a bigger VPS. Naively running multiple replicas will *appear* to work in a smoke test, then fail under real load:
  - split-brain container lifecycle — two processes race on `docker run --name ws_X`; idle timers and `startLocks` are per-process, so the coalescing guarantee is lost
  - conversation amnesia — history lives in one process's `global._workspaces`; a turn routed to a different instance sees empty `messages`
  - dropped console output — a browser's WebSocket lives in the process that accepted it, but the agent run (and its `broadcastToWorkspace` calls) may execute in another, which holds no socket for that workspace
  - stale caches / bypassed limits — `global._apiKeys` and auth-failure counters are per-process; a rotated key keeps working on un-restarted instances, and lockout/rate limits become `N×` the configured value
- **To lift the ceiling later**, externalize: workspace history + todos + API-key state into a shared store (Redis/Postgres), WS fan-out via pub/sub or sticky sessions, and container ownership via a single manager process or a distributed lock (plus a scheduler deciding which host runs each workspace).

## Alternatives considered

- **Externalize state up front (Redis/Postgres + pub/sub):** enables horizontal scaling but adds infrastructure, latency, and operational burden that a single-VPS self-hosted product does not need. Deferred until a concrete multi-instance requirement exists.
- **Leave the assumption implicit:** rejected — the single-process dependency is spread across six modules and only visible by tracing `global.*` usage, making it an easy landmine for a future "just add replicas" change.

## Notes

- Related: `adr-global-object-hot-reload-survival.md` (why the state is on `global`), `adr-metadata-storage-json-vs-db.md`, `adr-container-per-workspace-sandbox.md`.
- Load-bearing files: `lib/infra/workspaceStore.ts`, `lib/infra/apiKeyStore.ts`, `lib/infra/wsHub.ts`, `lib/infra/containerManager.ts`, `lib/infra/todoStore.ts`, `server.ts`.
