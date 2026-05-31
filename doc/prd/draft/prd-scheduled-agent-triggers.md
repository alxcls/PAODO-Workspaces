# PRD — Scheduled Agent Triggers

**Status:** Draft  
**Author:** alxcls  
**Related:** [VISION.md](../../VISION.md)

---

## Problem

Agents only run when a user explicitly sends a message. Services need to act on a timer — stock checks, nightly reports, hourly monitoring — without manual intervention.

## Goals

- Users can define cron jobs per workspace that fire the agent with a configured prompt.
- Jobs are managed by the platform only; the agent has no access to job routes.
- Job definitions persist outside workspace containers so they survive container recreation.

## Non-goals

- Monitoring dashboard or run history UI (tracked in monitoring PRDs).
- Cross-workspace scheduling via cron — use the agent network for that.
- Missed-run catch-up when the server was offline.
- Notifications on completion.

## User stories

- As a workspace owner, I want to schedule a daily prompt so my agent runs routine tasks automatically.
- As a workspace owner, I want to disable a job without deleting it.
- As a workspace owner, I want to see when a job last ran and whether it succeeded.

## Requirements

### Must have

- **CRUD API** at `/api/workspaces/[id]/schedules` — create, list, update, delete.
- **Job record** — `id`, `workspaceId`, `cronExpression`, `prompt`, `enabled`, `createdAt`, `lastRunAt`, `lastRunStatus`, `lastRunSnippet`.
- **Platform-only** — agent has no route access to job management; jobs are opaque to it.
- **Stored outside containers** — persisted in `.data/.cron-schedules.json`, never inside the workspace directory.
- **Fresh conversation per run** — each run starts clean (system prompt only), independent of prior runs.
- **Non-reentrant** — skip a fire if the same job is already running.
- **No rate-limit** — internal runs bypass the per-IP rate limiter.

### Nice to have

- UI panel with enable/disable toggle and last-run status per job.
- "Run now" button.
- Timezone support per job.
