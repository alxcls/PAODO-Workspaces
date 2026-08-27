# ADR: Upload & workspace file layout

Status: Accepted
Date: 2026-05-25

Context

Workspaces need a simple, safe place to store files uploaded via the UI.

Decision

- Store each workspace under `./data/<workspace-name>` (root defaults to `./data/`, configurable via `WORKSPACES_ROOT` env var) and record metadata in `<root>/.workspaces.json`.
- Accept uploads at `POST /api/workspaces/[id]/files/upload` in two modes: single-file (`?path=`) and ZIP (`Content-Type: application/zip`).
- Enforce size limits (100MB per file, 500MB per ZIP) and use `fs.realpath` on the workspace root + `path.normalize`/`path.resolve` + prefix check to prevent `../` traversal.
- Apply an in-process rate limit for upload requests.
- Return standard HTTP codes for limit/validation/write failures (404, 429, 413, 400, 207, 500).

Consequences

- Simple on-disk layout is easy to inspect and mount for containers.
- Current design buffers uploads in memory and uses local storage; it does not provide cross-instance quotas, scanning, or external durability.

Alternatives considered

- External object storage (S3/GCS) for scalability — deferred.
- Streamed uploads to avoid buffering — deferred.

Files: `lib/infra/workspace/registry.ts`, `app/api/workspaces/[id]/files/upload/route.ts`, `lib/infra/security/rateLimit.ts`
