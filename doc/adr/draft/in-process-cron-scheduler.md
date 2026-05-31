# ADR — In-process cron scheduler with node-cron

**Status:** Draft

## Context

Scheduled agent triggers need a scheduling primitive inside the server process. Key constraints:
- Single Node.js process; no external datastore (see ADR `metadata-storage-json-vs-db.md`).
- Job definitions must live outside workspace containers — containers can be recreated and the scheduler runs in the server process, not inside any container.
- The agent must have no access to job management; scheduling is a platform-only concern.

## Decision

Use `node-cron` in-process. Two new infra modules:

- **`lib/infra/cronStore.ts`** — persists jobs to `data/.cron-schedules.json` (same atomic-write pattern as `workspaceStore.ts`).
- **`lib/infra/scheduler.ts`** — owns the `node-cron` job registry; exposes `loadAll()` called once from `server.ts` at startup.

Scheduled runs use a headless runner that drains `runAgent()` to completion with no SSE consumer, then writes the outcome back to the store. Non-reentrance is enforced by a `Set` of in-flight job IDs.

## Consequences

- No new infrastructure; integrates with existing patterns.
- Reliability is tied to the server process — crashes cancel in-flight jobs, missed ticks while offline are not replayed.
- Horizontal scaling would cause duplicate fires; acceptable for now.

## Alternatives considered

**System cron + HTTP call** — requires public server reachability; rejected.  
**Separate worker process** — too complex for current scale; rejected.  
**Bull/BullMQ + Redis** — contradicts no-external-db decision; rejected.

## Notes

Related PRD: `doc/prd/draft/prd-scheduled-agent-triggers.md`
