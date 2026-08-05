# Library boundaries

PAODO organizes server code by responsibility:

- `operations/` owns trigger-neutral business use cases. HTTP, CLI, MCP, schedule, and agent adapters call these operations instead of reproducing their rules.
- `workspace/` and `schedules/` contain an entity and its pure policies only — no store, no logger, no transport. `schedules/nextRun.ts` is the shape of this: "when does this fire next" is the same answer whichever trigger asks, so it sits beside the record rather than in `infra/`.
- `infra/` contains concrete persistence, process, filesystem, Docker, Git, proxy, and realtime adapters.
- Capability folders such as `files/`, `uploads/`, `models/`, `conversations/`, `drives/`, `skills/`, `transcript/`, and `usage/` contain code shared by more than one adapter or resource.
- `api/` translates operation outcomes into HTTP responses; `client/` contains browser-side behavior.

Prefer a named capability folder over catch-all `utils`, `helpers`, or `stores` folders. Tests stay next to the module they exercise.

When both the server and the browser need to speak the same shape, that shape belongs in a capability
folder rather than in `client/` — `transcript/` exists for exactly that reason: `agent/` projects stored
history into the rendered-message shape while `client/` folds live events into it, so neither owns it.
