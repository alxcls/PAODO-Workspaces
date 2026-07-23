# Reference deployment — Debian, Docker, and Tailscale

This is one tested, security-minded deployment profile for PAODO on a Debian 13
VPS. PAODO itself requires Docker, an `.env`, and a network path you trust to
reach the app. This guide chooses Tailscale for private access and Caddy for an
optional restricted public API; you may instead use another VPN, reverse proxy,
network policy, or operating system that fits your environment.

In this reference profile, the responsibilities are:

| Component    | Role                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| VPS          | Runs Docker and PAODO. Its public IPv4 is used only when you deliberately enable the public API gateway.                                   |
| Tailscale    | Private administrator access to the VPS (SSH) and a private HTTPS URL for the full app. Only tailnet devices can use it.                   |
| DNS provider | Creates a public API hostname, such as `api.example.com`, when you opt into the direct Caddy API gateway. This is separate from Tailscale. |

The public API gateway is optional. It exposes two Bearer-key-protected routes
and no UI. The normal app UI remains private on Tailscale.

---

## What you need for this reference profile

- VPS running Debian 13 (Trixie)
- [Tailscale account](https://tailscale.com) (free)
- LLM API key (OpenAI, Anthropic, or DeepSeek)
- Optional: a domain and DNS-provider access for a public API hostname

---

## Step 1 — Secure VPS administration with Tailscale

Connect to your VPS using the IP address and root password provided by your hosting provider:

```bash
ssh root@your-vps-ip
```

Then install Tailscale and enable SSH over it:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh
```

The command prints an authentication URL — open it in a browser to link the VPS to your Tailscale account. `--ssh` lets you manage the VPS over Tailscale instead of a public IP.

Then close the public SSH port — it's no longer needed:

```bash
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw enable
```

**Before closing your current VPS session**, open a second terminal on your local machine and verify Tailscale SSH works:

```bash
ssh root@your-machine-name   # uses Tailscale IP, not public IP
```

Once confirmed, you can close the original session.

---

## Step 2 — Install Docker

Skip if `docker --version` and `docker compose version` already work.

```bash
apt update && apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian trixie stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

---

## Step 3 — Clone and configure

```bash
git clone https://github.com/alxcls/PAODO_WS.git
cd PAODO_WS
cp .env.example .env
chmod 600 .env
nano .env
```

| Variable                       | Required           | Description                                                                                                             |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`               | If using OpenAI    | Your OpenAI API key                                                                                                     |
| `ANTHROPIC_API_KEY`            | If using Anthropic | Your Anthropic API key                                                                                                  |
| `DEEPSEEK_API_KEY`             | If using DeepSeek  | Your DeepSeek API key                                                                                                   |
| `MOONSHOT_API_KEY`             | If using Kimi      | Your Moonshot AI (Kimi) API key                                                                                         |
| `ANTHROPIC_CACHE_TTL_1H`       | No                 | Opt into Anthropic's 1-hour prompt cache TTL; leave unset for the default cache behavior                                |
| `USERNAME`                     | Yes                | Login username                                                                                                          |
| `PASSWORD`                     | Yes                | Login password                                                                                                          |
| `PORT`                         | No                 | Port the server listens on (default: `3000`)                                                                            |
| `LOG_LEVEL`                    | No                 | `trace` / `debug` / `info` / `warn` / `error` / `fatal` (default: `info`)                                               |
| `GRAPH_ENABLED`                | No                 | Multi-agent graph and `/graph` UI; on by default — set `false` to disable agent-to-agent calls (default: `true`)        |
| `SKILL_INPUT_MAX_RETRIES`      | No                 | Consecutive input-schema failures for one (callee, skill) before `call_agent` returns a terminal error (default: `2`)   |
| `SKILL_OUTPUT_MAX_RETRIES`     | No                 | Output-schema correction passes before a call fails with `OUTPUT_VALIDATION_ERROR` (default: `2`)                       |
| `SKILL_NEEDS_INPUT_MAX_ROUNDS` | No                 | How many `NEEDS_INPUT` rounds a callee may ask for one (callee, skill) before the caller is told to stop (default: `2`) |
| `CONTAINER_MEMORY`             | No                 | Memory cap per workspace container (default: `1g`)                                                                      |
| `CONTAINER_CPUS`               | No                 | CPU cap per workspace container (default: `1.0`)                                                                        |
| `CONTAINER_IDLE_MS`            | No                 | Idle timeout before a workspace container stops (default: `600000` = 10 min)                                            |
| `EXEC_SILENCE_TIMEOUT_MS`      | No                 | Kills a shell command if it produces no output for this long (default: `60000` = 1 min)                                 |
| `EXEC_MAX_TIMEOUT_MS`          | No                 | Kills a shell command after this total elapsed time regardless of output (default: `1800000` = 30 min)                  |

Production startup requires at least one of the three LLM provider API keys.

Startup also fails closed when the workspace data volume, registry, encrypted secret store,
credential-proxy key material, workspace image, or HTTP listener is unavailable. These conditions
emit a structured `fatal` record before the process exits; the credential-proxy sidecar likewise
exits on listener failure so Docker can restart it.

Provider, model, and reasoning effort are not set here — each workspace picks them in the UI's Model block.

---

## Step 4 — Start the app

```bash
# Build the local PAODO image explicitly on the first run, then start all services.
docker compose up --build -d

# All checks should succeed.
docker compose ps
```

This starts three long-running containers: `app`, `socket-proxy`, and `credproxy`.

Nothing is written to a log file on the host. Every container logs line-delimited JSON to stdout, where Compose's `json-file` driver captures and rotates it at 10 MB × 5 per service. See [Reading the logs over SSH](#reading-the-logs-over-ssh).

### How workspace egress works (credential proxy)

Workspace containers reach the internet only through the `credproxy` sidecar — their `HTTP_PROXY`/`HTTPS_PROXY` point at it. The proxy tunnels ordinary traffic (pip, apt, git, npm) untouched and substitutes secret tokens for real values only on requests to each workspace's configured domains.

The proxy runs in its **own** container, deliberately kept off the app's networks. The app attaches `credproxy` — never itself — to each per-workspace network, so a workspace can reach port 9998 (the proxy) and nothing else the app hosts (the control plane on the web port and `/ws` stay unreachable from the sandbox). Because the proxy is reached over the internal Docker networks, **port 9998 is never published to the host and needs no firewall rule** — the UFW config from Step 1 is all that's required.

---

## Step 5 — Reach the private app through Tailscale

The full app includes the UI, management routes, WebSocket endpoint, and every
API route. Tailscale Serve makes it available only to devices in your tailnet.

First, enable Tailscale Serve in the admin console:

1. Go to your [Tailscale admin console](https://login.tailscale.com/admin/dns)
2. Enable **HTTPS certificates** — this is required for Serve to work
3. Leave **Tailscale Funnel** off — that exposes to the public internet, which you don't want

Then run:

```bash
tailscale serve --bg http://127.0.0.1:<your-port>   # <your-port> must match PORT in your .env (default: 3000)
tailscale serve status   # prints your HTTPS URL, e.g. https://your-machine.tail-xxxx.ts.net
```

Use `127.0.0.1`, not `localhost`: the app is published on IPv4 only, and `localhost` resolves to `::1` first — the fallback hides the failed dial until it surfaces under load as intermittent 502s.

Open that URL on any device in your tailnet, enter your `USERNAME` and `PASSWORD`, and you're in. Devices outside your tailnet cannot reach it.

---

## Optional — direct public HTTPS access for workspace API and MCP

To let an external system call a workspace without joining your tailnet, enable
the optional Caddy gateway. It exposes only these bearer-protected routes:

```text
POST /api/workspaces/<workspace-id>/agent
POST /api/workspaces/<workspace-id>/mcp
```

1. At the DNS provider that manages your domain, create an `A` record for a
   hostname such as `api.example.com`, pointing to the VPS's **public IPv4**.
   This is not configured in Tailscale or on the VPS.

   The record must send traffic directly to the VPS, not through a tunnel or
   another reverse proxy: Caddy must receive ports 80 and 443 to obtain and
   renew its certificate.

2. Set the public hostname and the VPS's public IPv4 address in `.env`:

   ```env
   WORKSPACE_API_DOMAIN=<your-public-api-hostname>
   WORKSPACE_API_BIND_IP=<your-vps-public-ipv4>
   ```

   Replace both placeholders with your own values; they are not shared defaults.
   The gateway binds only that public address. This lets Tailscale Serve keep
   using HTTPS on the VPS's Tailscale address for the private app.

3. Allow ports 80 and 443 through the firewall so Caddy can serve the API and
   renew its certificate. Both rules accept traffic from any source, so the
   gateway is reachable at the VPS's public IPv4, not only at your hostname:

   ```bash
   ufw allow 80/tcp
   ufw allow 443/tcp
   ```

4. Start the normal private stack plus the gateway:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml up -d
   ```

Generate and enable an API key for the target workspace in PAODO, then call it:

```bash
curl --request POST https://api.example.com/api/workspaces/<workspace-id>/agent \
  --header "Authorization: Bearer <workspace-api-key>" \
  --header "Content-Type: application/json" \
  --data '{"message":"Process this request"}'
```

For MCP, generate an MCP secret in the workspace's **Workspace MCP access** panel,
publish the desired skills, and connect the client to
`https://api.example.com/api/workspaces/<workspace-id>/mcp`.

The gateway returns `404` for the UI, WebSocket endpoint, configuration routes,
and every other app route. It also replaces caller-supplied client-IP headers before forwarding, so
the app's rate limiter and audit logs use the real caller IP. To disable public
API/MCP access, stop the gateway and remove the two firewall rules; the Tailscale
app remains available.

From a tailnet device, the same Bearer API endpoint also works through the
private Tailscale Serve URL. The Caddy hostname is needed only for callers that
must reach the API or MCP endpoint from the public internet.

---

## Keeping it up to date

```bash
# Pull latest code and rebuild
git pull && docker compose up --build -d

# Apply a config change (.env edit) without rebuilding
docker compose up -d
```

> **Always rebuild _all_ services — never `docker compose up -d --build app`.** The
> `credproxy` sidecar runs the **same `paodo_ws_app` image but as a separate long-lived
> container**. Scoping the deploy to `app` rebuilds the image and recreates only the app,
> leaving `credproxy` running stale code indefinitely. That silently breaks per-workspace
> secret injection (e.g. `gh`/GitHub auth) whenever the proxy code changes. `docker compose
up --build -d` with no service filter recreates the sidecar from the fresh image too.

---

## Operations

```bash

docker images                                                       # Check docker image

docker ps                                                           # container status

docker ps -a                                                        # container status (idle container included)

docker stats                                                        # live CPU/RAM per container

docker system df                                                    # disk usage (images, containers, volumes)

tailscale status                                                    # VPN status
```

### Backing up usage history

Usage history, including prompts and tool output, lives in SQLite at `/app/data/.usage.db`. Do not
copy that live file directly: the database uses WAL mode, so a raw file copy can omit committed
pages. Create a consistent snapshot through the app, copy it to separately backed-up storage, then
remove the temporary same-volume snapshot:

```bash
docker compose exec -T app npm run backup:usage -- /app/data/.usage-backup.db
docker compose cp app:/app/data/.usage-backup.db /mnt/off-host-backups/paodo-usage.db
docker compose exec -T app rm /app/data/.usage-backup.db
```

Automate those commands with the host scheduler and give snapshots dated names plus an explicit
retention policy. `/mnt/off-host-backups` is only an example: it must be replicated or mounted from
another system. Keeping the copy on the VPS does not protect against host or volume loss.

### Reading the logs over SSH

Everything is line-delimited JSON, so `jq` works on all of it.

Everything goes to container stdout — there is no log file on the host. Docker keeps 10 MB × 5
files per service and rotates them for you.

`--no-log-prefix` is required on every command piped into `jq`. Without it Compose prefixes each
line with `app-1  | `, which is not JSON — `fromjson?` then discards the line and the filter returns
nothing at all rather than failing.

```bash
# Everything the app is doing, live. Use this first — errors, warnings and successful
# requests all appear here.
docker compose logs -f --no-log-prefix app | jq -R 'fromjson? // .'
docker compose logs -f --no-log-prefix credproxy | jq -R 'fromjson? // .'

# Security events only: auth failures, rate-limit trips, credential lifecycle changes.
docker compose logs --no-log-prefix app | jq -R 'fromjson? // empty | select(.audit)'

# Who is failing to authenticate, and how often.
docker compose logs --no-log-prefix app \
  | jq -Rr 'fromjson? // empty | select(.event | startswith("auth_")) | "\(.ip) \(.event)"' \
  | sort | uniq -c | sort -rn

# Everything around an incident, newest last.
docker compose logs --since 1h --no-log-prefix app | jq -R 'fromjson? // empty'
```

A `suppressed: N` field means that line stands in for N more identical rejections in the same
window. Rejection paths (rate limits, auth failures, CSRF blocks) are throttled because an
unauthenticated caller controls how often they fire, and an unthrottled flood would rotate real
history out of Docker's 50 MB window in minutes.

Set `LOG_LEVEL` in `.env` to change verbosity (default `info`). Note it applies to audit events too,
so raising it above `info` will hide the low-severity ones.

Logs do not survive `docker compose down` plus a container wipe. If you later need an audit trail
that does, ship stdout to something outside the host rather than reintroducing a bind-mounted file —
a log driver or a collector is the same one-line change and someone else maintains the rotation.
