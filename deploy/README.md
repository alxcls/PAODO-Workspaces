# Self-hosting PAODO on a VPS

This guide runs PAODO on Debian 13. It keeps the roles of the VPS, Tailscale,
Cloudflare, and public DNS separate:

| Component | Role |
|---|---|
| VPS | Runs Docker and PAODO. Its public IPv4 is used only when you deliberately enable the public API gateway. |
| Tailscale | Private administrator access to the VPS (SSH) and, optionally, a private HTTPS URL for the full app. Only tailnet devices can use it. |
| Cloudflare Tunnel + Access | Optional protected browser URL for the full app, such as `ws.example.com`. Cloudflare handles the public edge and email login. |
| DNS provider | Creates a public API hostname, such as `api.example.com`, when you opt into the direct Caddy API gateway. This is separate from Tailscale and from a Cloudflare Tunnel hostname. |

The public API gateway is optional. It exposes one Bearer-key-protected route and no UI. A normal deployment can use only Tailscale, only Cloudflare Tunnel + Access, or both.

---

## What you need

- VPS running Debian 13 (Trixie)
- [Tailscale account](https://tailscale.com) (free)
- LLM API key (OpenAI, Anthropic, or DeepSeek)
- Optional: a domain and DNS-provider access for a public API hostname
- Optional: Cloudflare Tunnel + Access for an email-protected browser URL

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

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | Yes | `openai`, `anthropic`, or `deepseek` (default: `openai`) |
| `OPENAI_API_KEY` | If using OpenAI | Your OpenAI API key |
| `OPENAI_MODEL` | If using OpenAI | Model name, e.g. `gpt-5-mini` |
| `ANTHROPIC_API_KEY` | If using Anthropic | Your Anthropic API key |
| `ANTHROPIC_MODEL` | If using Anthropic | Model name, e.g. `claude-haiku-4-5` |
| `DEEPSEEK_API_KEY` | If using DeepSeek | Your DeepSeek API key |
| `DEEPSEEK_MODEL` | If using DeepSeek | Model name, e.g. `deepseek-v4-pro` |
| `REASONING_EFFORT` | No | `low` / `medium` / `high`; maps to OpenAI effort or Anthropic thinking budget (default: `low`) |
| `USERNAME` | Yes | Login username |
| `PASSWORD` | Yes | Login password |
| `PORT` | No | Port the server listens on (default: `3000`) |
| `LOG_LEVEL` | No | `trace` / `debug` / `info` / `warn` / `error` / `fatal` (default: `info`) |
| `GRAPH_ENABLED` | No | Multi-agent graph and `/graph` UI; on by default — set `false` to disable agent-to-agent calls (default: `true`) |
| `SKILL_INPUT_MAX_RETRIES` | No | Consecutive input-schema failures for one (callee, skill) before `call_agent` returns a terminal error (default: `2`) |
| `SKILL_OUTPUT_MAX_RETRIES` | No | Output-schema correction passes before a call fails with `OUTPUT_VALIDATION_ERROR` (default: `2`) |
| `SKILL_NEEDS_INPUT_MAX_ROUNDS` | No | How many `NEEDS_INPUT` rounds a callee may ask for one (callee, skill) before the caller is told to stop (default: `2`) |
| `CONTAINER_MEMORY` | No | Memory cap per workspace container (default: `1g`) |
| `CONTAINER_CPUS` | No | CPU cap per workspace container (default: `1.0`) |
| `CONTAINER_IDLE_MS` | No | Idle timeout before a workspace container stops (default: `600000` = 10 min) |
| `EXEC_SILENCE_TIMEOUT_MS` | No | Kills a shell command if it produces no output for this long (default: `60000` = 1 min) |
| `EXEC_MAX_TIMEOUT_MS` | No | Kills a shell command after this total elapsed time regardless of output (default: `1800000` = 30 min) |

---

## Step 4 — Start the app

```bash
# Pre-create the security-log dir owned by the app's UID (1000) so the bind-mounted
# /logs is writable — the hardened container can't chown it itself. Change the path freely.
mkdir -p /var/log/paodo && chown 1000:1000 /var/log/paodo
docker compose up -d
```

This starts three containers: `app` (the web UI + agent), `socket-proxy` (a locked-down Docker API), and `credproxy` (the credential proxy that injects per-workspace secrets into outbound requests).

### How workspace egress works (credential proxy)

Workspace containers reach the internet only through the `credproxy` sidecar — their `HTTP_PROXY`/`HTTPS_PROXY` point at it. The proxy tunnels ordinary traffic (pip, apt, git, npm) untouched and substitutes secret tokens for real values only on requests to each workspace's configured domains.

The proxy runs in its **own** container, deliberately kept off the app's networks. The app attaches `credproxy` — never itself — to each per-workspace network, so a workspace can reach port 9998 (the proxy) and nothing else the app hosts (the control plane on the web port and `/ws` stay unreachable from the sandbox). Because the proxy is reached over the internal Docker networks, **port 9998 is never published to the host and needs no firewall rule** — the UFW config from Step 1 is all that's required.

---

## Step 5 — Choose how to reach the full app

The full app includes the UI, management routes, WebSocket endpoint, and every
API route. Choose one or both of the following protected access paths.

### Option A — private HTTPS through Tailscale Serve

First, enable Tailscale Serve in the admin console:

1. Go to your [Tailscale admin console](https://login.tailscale.com/admin/dns)
2. Enable **HTTPS certificates** — this is required for Serve to work
3. Leave **Tailscale Funnel** off — that exposes to the public internet, which you don't want

Then run:

```bash
tailscale serve --bg http://localhost:<your-port>   # <your-port> must match PORT in your .env (default: 3000)
tailscale serve status   # prints your HTTPS URL, e.g. https://your-machine.tail-xxxx.ts.net
```

Open that URL on any device in your tailnet, enter your `USERNAME` and `PASSWORD`, and you're in. Devices outside your tailnet cannot reach it.

---

### Option B — protected browser access through Cloudflare Tunnel

Use this when you want a browser URL such as `https://ws.example.com`, protected
by Cloudflare Access (for example, an email-login policy). In the Cloudflare
dashboard, configure the existing Tunnel's public hostname to forward
`ws.example.com` to:

```text
http://localhost:<your-port>
```

Protect that hostname with a Cloudflare Access application. The Tunnel is an
outbound connection from the VPS: it does **not** require opening ports 80 or
443 in UFW. This hostname exposes the full app after Cloudflare Access permits
the request; it is not the restricted public API gateway below.

You can keep Tailscale Serve enabled alongside Cloudflare Tunnel. They are two
independent ways to reach the same private app listener.

---

## Optional — direct public HTTPS access for the workspace API

To let an external system call a workspace without joining your tailnet or
passing a Cloudflare email-login policy, enable the optional Caddy gateway. It
exposes only this route, protected by the workspace's existing Bearer API key:

```text
POST /api/workspaces/<workspace-id>/agent
```

1. At the DNS provider that manages your domain, create an `A` record for a
   hostname such as `api.example.com`, pointing to the VPS's **public IPv4**.
   This is not configured in Tailscale or on the VPS.

   If your DNS provider is Cloudflare, create an `A` record with **Proxy status:
   DNS only** (grey cloud). Do not add this hostname as a Cloudflare Tunnel
   public hostname: Caddy must receive ports 80 and 443 directly to obtain and
   renew its certificate.

   Use a hostname distinct from the Cloudflare Tunnel UI hostname; for example,
   use `ws.example.com` for the protected UI and `api.example.com` for the
   restricted public API.
2. Set the public hostname and the VPS's public IPv4 address in `.env`:

   ```env
   WORKSPACE_API_DOMAIN=api.example.com
   WORKSPACE_API_BIND_IP=203.0.113.10
   ```

   The gateway binds only that public address. This lets Tailscale Serve keep
   using HTTPS on the VPS's Tailscale address for the private app.
3. Allow ports 80 and 443 through the firewall so Caddy can obtain and renew
   the TLS certificate:

   ```bash
   ufw allow 80/tcp
   ufw allow 443/tcp
   ```

4. Start the normal private stack plus the gateway:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.workspace-api.yml up -d
   ```

Generate and enable a key for the target workspace in PAODO, then call it:

```bash
curl --request POST https://api.example.com/api/workspaces/<workspace-id>/agent \
  --header "Authorization: Bearer <workspace-api-key>" \
  --header "Content-Type: application/json" \
  --data '{"message":"Process this request"}'
```

The gateway returns `404` for the UI, WebSocket endpoint, and every other app
route. It also replaces caller-supplied client-IP headers before forwarding, so
the app's rate limiter and audit logs use the real caller IP. To disable public
API access, stop the gateway and remove the two firewall rules; the Tailscale
and/or Cloudflare Tunnel app access paths remain available.

From a tailnet device, the same Bearer API endpoint also works through the
private Tailscale Serve URL. The Caddy hostname is needed only for callers that
must reach the API from the public internet.

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
> up --build -d` with no service filter recreates the sidecar from the fresh image too.

---

## Operations

```bash

docker images                                                       # Check docker image

docker ps                                                           # container status

docker ps -a                                                        # container status (idle container included)

docker compose logs -f app                                          # live app logs (pretty-printed)

docker stats                                                        # live CPU/RAM per container

docker system df                                                    # disk usage (images, containers, volumes)

tailscale status                                                    # VPN status
```
