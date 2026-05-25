# ADR: Upload & workspace file layout

Status: Accepted
Date: 2026-05-25

Context

Workspaces need a simple, safe place to store files uploaded via the UI and API.

Decision

- Store each workspace under `./data/<workspace-name>` and record metadata in `./data/.workspaces.json`.
- Accept uploads at `POST /api/workspaces/[id]/files/upload` in two modes: single-file (`?path=`) and ZIP (`Content-Type: application/zip`).
- Enforce size limits (100MB per file, 500MB per ZIP) and use `fs.realpath` + `path.resolve` to prevent directory traversal or symlink escape.
- Apply an in-process rate limit for upload requests.
- Return standard HTTP codes for limit/validation/write failures (429, 413, 400, 207, 500).

Consequences

- Simple on-disk layout is easy to inspect and mount for containers.
- Current design buffers uploads in memory and uses local storage; it does not provide cross-instance quotas, scanning, or external durability.

Alternatives considered

- External object storage (S3/GCS) for scalability — deferred.
- Streamed uploads to avoid buffering — deferred.

Files: `lib/infra/workspaceStore.ts`, `app/api/workspaces/[id]/files/upload/route.ts`, `lib/infra/rateLimit.ts`
