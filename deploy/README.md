# Self-Hosting on a VPS example

A personal PAODO Workspace instance running on a VPS, accessible only over Tailscale VPN. The app is never exposed to the public internet. this example uses Debian 13 on a VPS with tailscale VPN.

---

## What you need

- VPS running Ubuntu Debian 13
- [Tailscale account](https://tailscale.com) (free)
- LLM API key (OpenAI or Anthropic)

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

## Step 3 — Clone and configure

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo
cp .env.example .env
chmod 600 .env
nano .env
```

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | Yes | `openai` or `anthropic` |
| `OPENAI_API_KEY` | If using OpenAI | Your OpenAI API key |
| `OPENAI_MODEL` | If using OpenAI | Model name, e.g. `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | If using Anthropic | Your Anthropic API key |
| `ANTHROPIC_MODEL` | If using Anthropic | Model name, e.g. `claude-sonnet-4-6` |
| `USERNAME` | Yes | Login username |
| `PASSWORD` | Yes | Login password |
| `LOG_LEVEL` | No | `trace` / `debug` / `info` / `warn` / `error` / `fatal` (default: `info`) |
| `GRAPH_ENABLED` | No | `true` to enable the multi-agent graph and `/graph` UI (default: `true`) |
| `CONTAINER_MEMORY` | No | Memory cap per workspace container (default: `1g`) |
| `CONTAINER_CPUS` | No | CPU cap per workspace container (default: `1.0`) |
| `CONTAINER_IDLE_MS` | No | Idle timeout before a workspace container stops (default: `600000` = 10 min) |

---

## Step 4 — Start the app

```bash
mkdir -p /var/log/paodo && chown 1000:1000 /var/log/paodo
docker compose up -d
```

---

## Step 5 — Expose via Tailscale and open the app

```bash
tailscale serve --bg http://localhost:3000
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

# Enable automatic OS security patches
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

---

## Operations

```bash
docker compose logs -f app                                          # live app logs
tail -f /var/log/paodo/security.log | jq '{ip:.ip,msg:.msg}'       # security events
docker compose restart app                                          # restart
docker compose stop                                                 # stop (keeps containers)
docker compose down                                                 # stop and remove containers (data preserved)
tailscale status                                                    # VPN status
```
