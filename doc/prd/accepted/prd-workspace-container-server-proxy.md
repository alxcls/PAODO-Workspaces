# PRD — Workspace Container Server Proxy

**Status:** Accepted (implemented)
**Author:** alxcls

---

## Problem

When the platform renders an HTML file inside the workspace file viewer, that HTML runs in a sandboxed frame in the browser. Any server running inside the workspace container (a local API, a database, etc.) is invisible to the browser — there is no direct network path from the user's browser to a process inside a Docker container on a private server.

This made it impossible to build interactive HTML tools that read or write data from a backend running in the same workspace.

## Goals

- HTML files previewed in the file viewer can `fetch()` data from a server running inside their workspace container.
- Works the same way in local development (`npm run dev`) and on the VPS.
- Container ports are never exposed to the public internet or to other workspaces.
- No extra configuration required from the agent or the user — a server on port 8080 just works.

## Non-goals

- Sharing data across multiple workspaces (a common database layer is a separate feature).
- Exposing the container server to anything other than the HTML preview inside the same workspace.
- Support for server-sent events or WebSocket connections through the proxy (plain HTTP only for now).

## User stories

- As a WS agent, I can start an HTTP server on port 8080 in my workspace and write an HTML file that calls it — the HTML preview will be able to fetch data from that server without any extra setup.
- As a user, I can preview a dashboard or form built by the agent and see it interact with live data from inside the workspace container.

## Requirements

### Must have

- A proxy route on the app server (`/api/workspaces/:id/proxy/...`) that forwards browser requests to the container's port 8080 and returns the response.
- Each workspace container gets a unique, randomly assigned host port mapped to its internal port 8080. Ports are bound to `127.0.0.1` only (never reachable from the network).
- HTML previews automatically receive the proxy URL as `window.API_BASE` so they can call it without hardcoding anything.
- Existing containers without a port mapping are silently recreated the next time the agent runs a command — workspace files on the volume are unaffected.
- Works on both macOS (`npm run dev`) and the Linux VPS (app inside Docker Compose).

### Nice to have

- Streaming / WebSocket support through the proxy.
- Multiple port mappings per container (for workspaces that run several services).
