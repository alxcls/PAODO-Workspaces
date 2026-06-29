# Self-Hosting on a VPS example

Goal: a personal PAODO Workspace instance running on a VPS, accessible only over Tailscale VPN. The app is never exposed to the public internet. This example uses Debian 13 on a VPS with Tailscale VPN.

The only hard requirements are Docker + Docker Compose, an `.env`, and a network path you trust to reach the app — it ships no public-internet hardening of its own. This guide uses Tailscale for that path, but a reverse proxy with auth, another VPN, an SSH tunnel, or a LAN-only setup works the same way. Everything Debian- and Tailscale-specific below is one reference path; adapt it freely to your host.

---

## What you need

- VPS running Debian 13 (Trixie)
- [Tailscale account](https://tailscale.com) (free)
- LLM API key (OpenAI, Anthropic, or DeepSeek)

---

## Step 1 — Install Tailscale and enable Tailscale SSH

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

## Step 3 — Cap the build cache

Every `docker compose --build` deploy adds to a single global BuildKit cache pool that otherwise grows without bound (workspace snapshot images are separate — they share layers and are deleted with their workspace, so they don't need this). One global ceiling keeps it bounded:

```bash
cat > /etc/docker/daemon.json <<'EOF'
{ "builder": { "gc": { "enabled": true, "defaultKeepStorage": "3GB" } } }
EOF
systemctl restart docker
```

`defaultKeepStorage` is one total budget for the whole daemon's build cache (not per workspace, not per snapshot). Docker GCs the oldest cache once the pool crosses it. Raise it on a roomy disk, lower it if disk is tight.

---

## Step 4 — Clone and configure

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

## Step 5 — Start the app

```bash
# Pre-create the security-log dir owned by the app's UID (1000) so the bind-mounted
# /logs is writable — the hardened container can't chown it itself. Change the path freely.
mkdir -p /var/log/paodo && chown 1000:1000 /var/log/paodo
docker compose up -d
```

---

## Step 6 — Expose via Tailscale and open the app

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

## Keeping it up to date

```bash
# Pull latest code and rebuild
git pull && docker compose up --build -d

# Apply a config change (.env edit) without rebuilding
docker compose up -d
```

---

## Operations

```bash

docker images                                                       # Check docker image

docker ps                                                           # container status

docker ps -a                                                        # container status (idle container included)

docker compose logs -f app                                          # live app logs (pretty-printed)

docker stats                                                        # live CPU/RAM per container

docker system df                                                    # disk usage (images, containers, volumes, build cache)

docker builder prune                                                # optional: manually reclaim build cache now (GC caps it automatically)

tailscale status                                                    # VPN status
```
