# ADR — Chokidar + WebSocket for live workspace file updates

Status: Accepted

## Context

The browser UI needs to reflect filesystem changes made by the agent in real time — new files in the tree and updated content in the viewer. The challenge is bridging the server-side filesystem to the browser without polling, and doing so per-workspace so events are not leaked across workspaces.

Next.js API routes cannot push events to the browser on their own; they are stateless request handlers. A persistent server-to-client channel is needed.

## Decision

A custom Node.js HTTP server (`server.ts`) intercepts HTTP upgrade requests: `/ws` paths are routed to a `ws.WebSocketServer`; all other upgrades (including Next.js HMR) are left for Next.js. This co-hosts the WebSocket server on the same port as the app.

When the first browser tab connects to a workspace, a chokidar watcher is started on that workspace's directory (`workspaceWatcher.ts`). The watcher:

- Batches `add`/`change` events with a 150 ms coalescing window (timer starts on first event, not reset by subsequent ones) before broadcasting `{ type: "files_changed", paths }`.
- On `unlink`, waits 200 ms then re-checks existence: if the file is back, emits `files_changed` (atomic move); otherwise emits `{ type: "files_deleted", paths }`.
- Uses `awaitWriteFinish` (100 ms stability threshold) to avoid firing mid-write.
- Suppresses `change` events for paths registered via `markSelfWrite` for 500 ms — called when the user saves a file manually, preventing a reload loop.

The watcher is stopped (with a 5-second grace period) when the last client disconnects. The per-workspace connection registry lives in `wsHub.ts` on the Node.js `global` object so it survives hot-reloads (see [global-object-hot-reload-survival](global-object-hot-reload-survival.md)).

On the client, the workspace page owns a single shared WebSocket and routes events to `FileViewer` via its imperative handle (`notifyFilesChanged` / `notifyFilesDeleted`). FileViewer itself holds no socket. On receipt:

- `files_changed`: silently re-fetches the open file's content, unless the user has unsaved edits (`isDirtyRef`).
- `files_deleted`: closes the viewer if the deleted path matches the open file.

The file tree (`FileTreePanel`) does not consume WebSocket events directly; it re-fetches the tree via REST when the `refreshKey` prop is bumped — currently only at end of agent turn.

## Consequences

- The open file viewer updates within ~250 ms of the agent completing a write, with no user action.
- The 5-second grace period on watcher teardown means a workspace keeps watching briefly after the last tab closes, which is benign.
- The file tree only refreshes at end of turn, not mid-turn — new files are not visible until the agent finishes its current step.
- Each open `FileViewer` holds one WebSocket connection; two tabs open on the same workspace create two connections to the same broadcast group, which is harmless.
- `DISABLE_WS_FILE_WATCH=1` disables all watchers for environments where chokidar is unsupported.

## Alternatives considered

- **Client polling**: simple but introduces latency proportional to the poll interval and wastes requests when nothing changes.
- **SSE (Server-Sent Events)**: unidirectional and would suffice for push, but cannot carry the `self_write` message back from client to server without a separate request. Also insufficient for shell output, which originates from Docker container stdout outside any HTTP request/response cycle and must be pushed to the browser unprompted.
- **Next.js Route Handlers with SSE**: cannot share state with the filesystem watcher without the global-object workaround; also conflicts with the WebSocket upgrade handling already needed.

## Notes

- Related PRD: [prd-live-workspace-file-updates.md](../../prd/accepted/prd-live-workspace-file-updates.md)
- Open question: drive the file tree refresh from WebSocket events mid-turn rather than waiting for end of turn.

### Update — Version Pin (2026-05)

- On macOS workspaces with very large trees (~17k+ files), upgrading to chokidar v5 (fs.watch-based, no fsevents) caused intermittent `EBADF` errors under load (initial tree scan + container startup + watcher initialization).
- We pinned chokidar to `3.5.3` to restore the native `fsevents` backend on macOS, which uses a single efficient stream instead of thousands of `fs.watch` handles. This eliminated the `EBADF` failures in the ACO workspace.
- Trade-offs: v3 is legacy; keep an eye on Node.js compatibility. Re-evaluate migrating to `@parcel/watcher` for a maintained, cross-platform native backend.
