Title: Usage detail stored unredacted, protected by network isolation

Status: Accepted

Context
The usage dashboard records rich per-turn detail to help operators understand and debug agent
runs: the user's prompt, the model's reasoning text, the agent's prose response, and every tool
call's arguments and output. This content is persisted append-only to `data/.usage.jsonl` and
served by two routes — `GET /api/usage` (light list: token counts + tool names/status only) and
`GET /api/usage/[sessionId]` (full per-session detail). Tool outputs can contain file contents,
command output, and secrets the agent encountered; prompts can contain sensitive instructions.

Neither route performs per-request authentication or authorization — consistent with the rest of
the app (e.g. the chat route), which relies on network-level isolation rather than in-app auth.
The default deployment keeps the app behind Tailscale. An optional public HTTPS gateway may open
ports 80 and 443, but it permits only the Bearer-authenticated workspace-agent endpoint; the usage
routes remain private.

Decision
Store usage detail unredacted and rely on network isolation for confidentiality. We do not redact,
encrypt, or auth-gate the usage data path. Confidentiality is provided by the private Tailscale
deployment surface; when enabled, the public gateway exposes only the separate Bearer-authenticated
workspace-agent endpoint. Retention is bounded by
`MAX_RECORDS` (5000) in `lib/workspace/usageStore.ts`: the in-memory list keeps the newest 5000
light records, and the JSONL file is compacted to its last `MAX_RECORDS` lines once it grows past
`COMPACT_AT` (1.5×), so heavy content on disk is bounded too.

Consequences
- The dashboard remains fully useful: operators can inspect exactly what each turn did, including
  raw tool I/O, without lossy redaction.
- Anyone with host or tailnet access to the VPS can read all workspaces' prompts and tool output,
  including any secrets the agent handled. This is acceptable under the single-user threat model
  but would NOT be acceptable if the app were ever multi-tenant or publicly exposed.
- If the deployment model changes (multi-user, public exposure), this ADR must be revisited:
  add per-request auth + per-workspace authorization on the usage routes, and consider redaction
  or encryption at rest.

Alternatives considered
- Redact secrets from tool output before persisting — rejected: unreliable (no robust secret
  detector), and it would strip exactly the detail the dashboard exists to show.
- Auth-gate / authorize the usage routes per workspace — rejected for now: inconsistent with the
  rest of the app's network-level auth model and unnecessary for a single user. Revisit if the
  threat model changes.
- Don't persist heavy content at all (token counts only) — rejected: loses the debugging value
  that motivated the feature.

Notes
Implementation: `lib/workspace/usageStore.ts`, `app/api/usage/route.ts`,
`app/api/usage/[sessionId]/route.ts`, `app/dashboard/page.tsx`.
