# Security Notes

## Threat model

This is a single-user, self-hosted app accessed exclusively over a private Tailscale network. The public internet cannot reach the app. Remaining threats:

- **Agent prompt injection** — a malicious page or file the agent fetches could instruct it to exfiltrate data or reach internal network services
- **Container escape / Docker daemon compromise** — if any code path on the host is exploited, an attacker who pivots from the app container to the Docker socket gets root on the VPS
- **Supply chain** — a compromised dependency introduced via a PR or dependency update

---

## Defense in depth

**Access**

- App reachable only by authenticated Tailscale devices; `tailscale serve` proxies to `127.0.0.1:<PORT>` — nothing else reaches that port
- SSH via Tailscale SSH (`tailscale up --ssh`); port 22 closed — no public SSH surface, no fail2ban needed
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

- HTTP Basic Auth covers all routes including `/api/*` and WebSocket upgrades — enforced before requests reach Next.js
- Timing-safe comparison (`crypto.timingSafeEqual`) for username and password
- Brute-force lockout: 5 failures / 60 s → 429 + `Retry-After`; counter resets on success
- Per-workspace Bearer tokens (SHA-256 hashed, constant-time comparison) for API access

**Rate limiting**

- 20 req/min per IP on agent, chat, and workspace-creation endpoints; 200 req/min on uploads

**Browser**

- Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, CSP, `Referrer-Policy`, `Permissions-Policy`
- No workspace-generated HTML is rendered by the app; web applications must be deployed before they are used in a browser
- CSRF guard: state-changing requests to `/api/*` are rejected when `Sec-Fetch-Site` is cross-site (server.ts `isCsrf`). Non-browser clients without `Sec-Fetch-Site` (for example, the Bearer-authenticated agent API) remain supported

**Operational**

- Security events (auth failures, rate-limit trips) logged to `/var/log/paodo/security.log` on the host — survives container restarts
- Server refuses to start in production if `USERNAME` or `PASSWORD` are unset
