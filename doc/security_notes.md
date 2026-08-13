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
- Process/thread cap per workspace container (`CONTAINER_PIDS_LIMIT`, default 512) — a fork bomb exhausts only its own container, never the host's PIDs
- `pids_limit` on the app and credential-proxy containers as well
- Containers auto-stop after idle timeout (`CONTAINER_IDLE_MS`, default 10 min)

**App-side memory ceilings**

The container limits above bound the workspace. They do nothing for memory held in the app, and that
is where the exhaustion crashes actually lived: a command's output was accumulated into one string,
and past V8's ~536M character limit the append throws `RangeError` from inside a stream handler —
a callback Node invokes directly, so no `.catch()` sees it. It reaches the process-level
`uncaughtException` guard, which exits, taking every workspace, socket and in-flight run with it.
`file_read` was worse: it copied the result three more times while numbering lines, so it could
exhaust the heap outright, which no `try/catch` can intercept at all. Both were reachable from
ordinary agent tool calls, so each path now has a ceiling.

The `drive_*` tools were a third case, and a distinct one: drives are read **host-side**, never
mounted into a container, so they sit above every ceiling built around the container transport and
were bounded by nothing at all. An agent asking to read a large file on a shared drive was enough
to take the instance down. They are bounded now too, and by refusal rather than truncation — both
transfer tools copy bytes, and half a database written to a destination is corruption that reports
success.

Note what is *not* underneath any of this: the app container declares no memory limit of its own.
These ceilings are the limit, and passing one costs the whole instance rather than one workspace.

None of these is an env knob, deliberately. Unlike `CONTAINER_MEMORY`, none depends on the host:
every PAODO instance runs the same kinds of workloads, so each of these has one right answer and an
operator asked to pick would have nothing to base the choice on. A knob nobody has cause to turn is
surface area, not flexibility — one bad value breaks things quietly.

Every one of these numbers lives in `lib/infra/limits.ts`, with the reasoning for the value beside
it; the mechanism that enforces it stays at the call site. They are together because the question
that matters is a whole-system one — *does every accumulating path have a bound?* — and it was
answered wrong twice while each ceiling owned its own copy of its number: `gitClient` kept the
unbounded append after `dockerClient` was fixed, and the host-side drive reads were missed entirely.
Neither miss was visible from any one file.

- Command output (`execute_command`): 30KB inline; the rest streams to a file in the container that
  the agent is given the path to — 20MB per file, 5 kept per container (`containerManager.ts`)
- File reads: 400KB (`fileRead.ts`), enforced in-container by `head -c` so an oversized file is
  never transferred; `offset`/`limit` pages past it
- Every docker and git subprocess: 8MB, one shared ceiling in `lib/infra/spawnCapture.ts` — a
  per-spawner copy is how the git path kept the bug after the docker path was fixed
- Live console sockets: 2MB buffered, 30s pinned (`wsHub.ts`) — `ws.send()` never blocks, so a tab
  that stopped reading queues its bytes in the app's heap, once per tab; past the ceiling messages
  are dropped (and reported to that tab) rather than queued
- Drive reads (`drive_read`): the same 400KB, since it is the same act — bytes into the context.
  Refused rather than truncated: the tool has no `offset`/`limit` to resume from, so the way through
  is `drive_download` followed by a paged `file_read`
- Drive transfers (`drive_download`, `drive_upload`): 50MB per file. Judged by peak, not file size —
  a download holds the bytes, their base64 copy, and the runner's copy of that at once, ~3.7×
- Drive listings (`drive_ls`): 1,000 entries, streamed with `opendir` so the ceiling bounds the
  directory scan and not merely the text it prints
- Every one of these reports when it cut something. A silently truncated result is the failure mode
  these ceilings introduce, and it is the one that makes an agent act on a false picture

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
