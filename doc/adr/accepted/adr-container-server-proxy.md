Title: Container server proxy via loopback port mapping

Status: Accepted

Context
HTML previews run as srcDoc iframes in the browser. The browser has no direct path to processes inside a workspace container on a private server. Without a bridge, agents cannot build HTML tools that read or write data from a backend running in the same workspace.

Decision
Each workspace container gets a unique host port allocated at creation time (getFreePort) mapped to container port 8080. A Next.js catch-all route `/api/workspaces/:id/proxy/[...path]` forwards browser requests to that port and returns the response.

Key choices:
- Port allocated with getFreePort (OS ephemeral port) at docker run time; stored in an in-memory map (portMap); re-queried from `docker port` on restart and cached.
- The host port is published on a specific interface, never `0.0.0.0`, so only the app can reach it (not the wider tailnet/host): `127.0.0.1` in local dev (app on host), and the Docker bridge gateway the app uses via `host.docker.internal` in production (resolved at runtime; override with `WORKSPACE_BIND_HOST`). See lib/infra/docker/containerManager.ts `resolveBindHost`. If gateway resolution fails it falls back to `0.0.0.0` so a publish never breaks — hardening, never a functional regression. UFW + Tailscale already block public ingress; this closes the tailnet/host side door.
- In Docker Compose the app container reaches the host via `host.docker.internal` (added through extra_hosts: host-gateway); in local dev `localhost` is used directly. The distinction is driven by whether WORKSPACES_VOLUME_NAME is set.
- The HTML preview iframe runs at an OPAQUE (null) origin — `sandbox="allow-scripts allow-forms"` with NO `allow-same-origin` — so agent-written HTML cannot ride the user's Basic Auth into the app API or other workspaces. To keep agent-built full-stack previews working, FileViewer injects `window.API_BASE = /api/workspaces/:id/proxy` plus a per-workspace `window.PREVIEW_TOKEN`; the fetch shim attaches the token as `Authorization: Bearer …` on proxied calls. server.ts accepts that token as a Basic-Auth bypass for that workspace's proxy/serve routes only (a token for workspace A fails on workspace B). The proxy/serve responses carry `Access-Control-Allow-Origin: null` (safe — gated by the unguessable token, no credentials). See lib/infra/security/previewToken.ts.
- Proxy forwards only `content-type` from the upstream request/response; all other headers are stripped. HTML and SVG responses receive `Content-Security-Policy: sandbox …` (no `allow-same-origin`) and `X-Content-Type-Options: nosniff` to prevent script execution in the app origin if a proxy URL is navigated to directly.
- Existing containers that predate the port mapping (portMissing check) are silently recreated; workspace volume data is unaffected.
- 30 s AbortSignal timeout on the upstream fetch; timeout falls through to the existing 502 handler.

Consequences
- Agents can build full-stack HTML tools (dashboards, forms, data explorers) without any extra user configuration.
- Each container consumes one loopback port for its lifetime; the OS ephemeral range (~28 k ports on Linux) sets the practical per-host workspace ceiling.
- Port is lost on app restart (in-memory map); re-queried from docker port on next access with no user-visible impact.
- Only plain HTTP; SSE and WebSocket through the proxy are not supported.

Alternatives considered
- **Direct container network exposure** — rejected; would require public port bindings or VPN routing, violating the "never reachable from outside the host" goal.
- **WebSocket tunnel through the existing /ws endpoint** — rejected; higher complexity, no clear benefit for the data-API use case.
- **Fixed port per workspace (hash-based)** — rejected; port collision risk with no recovery path.

Notes
PRD: doc/prd/accepted/workspace-container-server-proxy.md
