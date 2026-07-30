# Security Notes

## Threat model

This is a single-user, self-hosted app whose deployment should keep
administration, authenticated browser ingress, and the optional programmatic
gateway separate. Remaining threats:

- **Agent prompt injection** — a malicious page or file the agent fetches could instruct it to exfiltrate data or reach internal network services
- **Container escape / Docker daemon compromise** — if any code path on the host is exploited, an attacker who pivots from the app container to the Docker socket gets root on the VPS
- **Supply chain** — a compromised dependency introduced via a PR or dependency update
- **Edge or credential misconfiguration** — an incorrect ingress policy, Caddy route, or leaked Bearer credential could expose more capability than intended

---

## Defense in depth

**Access**

- The app listener is bound to `127.0.0.1:<PORT>` on the host; the selected UI ingress publishes it without opening that port to the internet
- The UI ingress may add an outer identity layer; PAODO Basic Auth remains the origin-level application credential
- SSH should use a private or tightly restricted administration path
- The DNS-direct Caddy gateway exposes only exact method/path combinations for authenticated programmatic API and Workspace MCP access; every other route returns `404`
- Each workspace container gets its own bridge network — no inter-container traffic
- Workspace container ports are not published to the host, so a local process cannot become a browser-facing app through the workspace

**Host**

- Unattended OS security upgrades — security packages install automatically; kernel patches require a manual reboot to take effect

**Process isolation**

- Each workspace runs in a dedicated Docker container — agents isolated from each other and the host filesystem
- App container runs as non-root user `app`
- Docker socket proxy (Tecnativa) — app accesses Docker through a restricted proxy, not the raw socket
- `cap_drop: ALL` + `no-new-privileges:true` on the app container
- `no-new-privileges:true` on every workspace container — setuid/setgid binaries cannot escalate privileges

**Container limits**

- Memory/CPU caps per workspace container (`CONTAINER_MEMORY`, `CONTAINER_CPUS`)
- Containers auto-stop after idle timeout (`CONTAINER_IDLE_MS`, default 10 min)

**Filesystem**

- File tools enforce path boundaries via `fs.realpath` + prefix checks — agents cannot escape their workspace directory
- Glob tool rejects absolute path patterns

**Agent**

- SSRF protection in `webFetch`: DNS-resolved IP validation blocks all private, loopback, CGNAT, and IPv6 local ranges before any request is made
- Agent-to-agent calls require an explicit graph edge

**Auth**

- HTTP Basic Auth covers browser UI routes and WebSocket upgrades after any outer ingress policy
- Timing-safe comparison (`crypto.timingSafeEqual`) for username and password
- Brute-force lockout: 5 failures / 60 s → 429 + `Retry-After`; counter resets on success
- Per-workspace Bearer tokens protect Agent API and MCP routes

**Rate limiting**

- 20 req/min per IP on agent, chat, and workspace-creation endpoints; 200 req/min on uploads

**Browser**

- Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, CSP, `Referrer-Policy`, `Permissions-Policy`
- No workspace-generated HTML is rendered by the app; web applications must be deployed before they are used in a browser
- CSRF guard: state-changing requests to `/api/*` are rejected when `Sec-Fetch-Site` is cross-site (server.ts `isCsrf`). Non-browser clients without `Sec-Fetch-Site` (for example, the Bearer-authenticated agent API) remain supported

**Operational**

- Explicit audit events (auth failures, rate-limit trips, and credential lifecycle changes) are logged with an `audit: true` tag, alongside operational logs on container stdout. Docker's `json-file` driver stores, bounds, and rotates them in managed files on the host; they do not survive container replacement.
- Server refuses to start if `USERNAME` or `PASSWORD` are unset — every mode, no opt-out. Previously gated on `NODE_ENV`, which meant flipping a container to debug logging served every route unauthenticated.
