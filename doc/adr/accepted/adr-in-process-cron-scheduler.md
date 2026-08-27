# ADR — In-process schedule tick loop

**Status:** Accepted

## Context

Scheduled agent triggers need a scheduling primitive inside the server process. Key constraints:

- Single Node.js process; no external datastore (see ADR `metadata-storage-json-vs-db.md`).
- Job definitions must live outside workspace containers — containers can be recreated and the scheduler runs in the server process, not inside any container.
- The agent must have no access to job management; scheduling is a platform-only concern.

## Decision

Run a single in-process tick loop over stored schedules — no cron library and no cron expressions. A
schedule is "every N minutes/hours/days/weeks from `startAt`", and each entry carries its own
`nextRunAt`, so a tick is a scan for entries whose instant has arrived. Three modules:

- **`lib/schedules/nextRun.ts`** — the recurrence math, timezone-aware via luxon so a daily schedule holds its wall-clock time across DST. Pure, and the single answer to "when does this fire next".
- **`lib/infra/schedules/scheduleStore.ts`** — persists one schedule per workspace to `.cron-schedules.json` under `WORKSPACES_ROOT` (same atomic-write pattern as `credentialStore.ts`).
- **`lib/infra/schedules/scheduler.ts`** — owns the tick timer, started once from `server.ts`; interval overridable with `SCHEDULE_TICK_MS`.

Each fire opens a fresh conversation and drives the agent through the run broker exactly as a user
message would, detached from any request so no browser need be attached. Because every fire uses a
new conversation id, the broker's own already-running guard cannot catch a still-running prior run,
so non-reentrance is enforced here by a `Set` of in-flight workspace ids.

## Consequences

- No new infrastructure and no scheduling dependency; integrates with existing patterns.
- Reliability is tied to the server process — crashes cancel in-flight runs, and there is no catch-up: on boot every `nextRunAt` is recomputed to the first occurrence strictly after now, so slots that elapsed while the server was offline are skipped.
- Firing accuracy is bounded by the tick interval rather than being exact.
- Horizontal scaling would cause duplicate fires; acceptable for now.

## Alternatives considered

**`node-cron` (or another cron library)** — cron expressions cannot express "every N units from an anchor", and the recurrence math we do need is small and worth owning; dropped.  
**System cron + HTTP call** — requires public server reachability; rejected.  
**Separate worker process** — too complex for current scale; rejected.  
**Bull/BullMQ + Redis** — contradicts no-external-db decision; rejected.

## Notes

Related PRD: `doc/prd/accepted/prd-scheduled-agent-triggers.md`
