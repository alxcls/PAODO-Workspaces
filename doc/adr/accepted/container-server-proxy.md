Title: Container server proxy via loopback port mapping

Status: Accepted

Context
HTML previews run as srcDoc iframes in the browser. The browser has no direct path to processes inside a workspace container on a private server. Without a bridge, agents cannot build HTML tools that read or write data from a backend running in the same workspace.

Decision
Each workspace container gets a unique host port allocated at creation time (getFreePort, bound to 127.0.0.1 only) mapped to container port 8080. A Next.js catch-all route `/api/workspaces/:id/proxy/[...path]` forwards browser requests to that port and returns the response.

Key choices:
- Port allocated with getFreePort (OS ephemeral port) at docker run time; stored in an in-memory map (portMap); re-queried from `docker port` on restart and cached.
- Binding to `127.0.0.1:port:8080` — never reachable from outside the host.
- In Docker Compose the app container reaches the host via `host.docker.internal` (added through extra_hosts: host-gateway); in local dev `localhost` is used directly. The distinction is driven by whether WORKSPACES_VOLUME_NAME is set.
- FileViewer injects `window.API_BASE = /api/workspaces/:id/proxy` into the srcDoc HTML so agents need no hardcoded URLs.
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
