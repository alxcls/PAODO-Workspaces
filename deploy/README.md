# Deploy PAODO

This guide deploys PAODO on a Linux VPS with Docker. A production deployment
requires secure SSH access and an HTTPS reverse proxy or tunnel for the UI.
External API or MCP access also requires a public DNS hostname. You may choose
the providers that supply those services.

## 1. Prepare the server

Install [Docker Engine and Docker Compose](https://docs.docker.com/engine/install/),
then restrict inbound access:

- default-deny inbound traffic and allow only your administrative access path;
- reach SSH over a VPN, a private tunnel, or a key-only public port — never a
  password-authenticated one;
- keep your provider's recovery console available, and confirm the new access
  path works from a second terminal **before** closing the session you are
  working in.

## 2. Configure PAODO

```bash
git clone https://github.com/alxcls/PAODO-Workspaces.git
cd PAODO-Workspaces
cp .env.example .env
chmod 600 .env
nano .env
```

Set:

- `PAODO_AUTH_MODE` to `basic` or `iap`, and the variables that mode requires;
- `PAODO_TRUSTED_HOSTS` to the UI's domain (comma-separated if several);
- `MAX_CONCURRENT_AGENT_RUNS` to the instance-wide emergency ceiling (start with `10`);
- optional container resource limits and timeouts.

After startup, enter at least one supported LLM provider key in **Settings → Provider API keys**.
Provider keys do not belong in `.env`.

The ceiling counts chat, API, scheduled, MCP, and nested agent-to-agent runs together. A request
above it is rejected immediately with `CAPACITY_REACHED`; PAODO does not queue it yet.

### Capacity test profile

Keep VPS experiments to these five adjustable walls:

```env
MAX_CONCURRENT_AGENT_RUNS=10
APP_MEMORY_LIMIT=2g
APP_CPUS=2.0
CONTAINER_MEMORY=1g
CONTAINER_CPUS=1.0
```

`CONTAINER_PIDS_LIMIT=512` is a safety wall rather than a performance target; change it only when a
legitimate thread-heavy workload reaches it. Apply app and concurrency changes with
`docker compose up -d`. Workspace limits are stamped onto each workspace container when it is first
created. Existing workspace containers preserve their installed state and current limits; resize one
explicitly when testing a new profile:

```bash
docker update --memory 1g --cpus 1.0 --pids-limit 512 ws_<workspace-id>
```

The structured application log provides the capacity trail needed to compare experiments:

- `capacity_guardrails_configured` records the profile read at application startup;
- `workspace_container_capacity_applied` records the limits stamped onto a new workspace container;
- `agent_run_started` and `agent_run_completed` record active and maximum agent-run counts;
- `agent_execution_capacity_reached` records a run refused by the emergency ceiling.

These are guardrails, not a capacity claim. Hold the VPS size and workload constant, change one
profile at a time, and use the resulting host metrics and events to find a safe operating point.

## 3. Start PAODO

```bash
docker compose up --build -d
docker compose ps
```

The app listens on `127.0.0.1:3000` by default. Keep that port private.

### Backups and credential handoff

Compose keeps six named volumes deliberately separate:

- `workspaces` contains workspace data;
- `proxy-ca` contains the credential proxy's CA, its HMAC key and the internet-access policy;
- `provider-vault` contains encrypted LLM provider keys;
- `provider-key` unlocks only the provider vault;
- `workspace-secret-vault` contains encrypted third-party secrets intended for proxy injection;
- `workspace-secret-key` unlocks only the workspace-secret vault.

`proxy-ca` is mounted at `/var/lib/paodo/data/.proxy-ca` — writable in `app`, read-only in `credproxy`, which
gets no other view of `workspaces`. Keeping it a volume of its own is what lets `credproxy` start on
a first deployment: a subpath mount requires the path to already exist in the volume, and on a fresh
install nothing has created it yet.

Back up each vault separately from its matching key when credentials must survive a restore. Anyone
who obtains a matching pair can recover that credential class. A credential-free handoff transfers
only `workspaces`. There is intentionally no migration from the former/shared greenfield format:
enter new credentials after switching to this layout.

Workspace containers reach the internet only through the `credproxy` sidecar,
over an internal Docker network. That port is never published to the host, so it
needs no firewall rule of its own.

## 4. Publish the UI

Configure your HTTPS reverse proxy or private tunnel to forward a UI hostname
to:

```text
http://127.0.0.1:3000
```

Use the literal `127.0.0.1`, not `localhost`: the app publishes on IPv4 only, and
`localhost` resolves to `::1` first. The failed dial stays hidden until it
surfaces under load as intermittent 502s.

Set that exact UI hostname in `PAODO_TRUSTED_HOSTS`. The ingress must replace, not append, `Host`
and `X-Forwarded-Host` with that hostname. PAODO rejects missing, malformed, unlisted or disagreeing
values before authentication. The optional `WORKSPACE_API_DOMAIN` is trusted automatically.

The ingress must support WebSocket upgrades for `/ws`. It must also discard any
caller-supplied `CF-Connecting-IP` header and replace it with the verified client
address, because PAODO uses that header for rate limits and audit logs.

Verify login, page loading, console/file live updates, and WebSocket reconnects.

## 5. Optional API and MCP gateway

The included Caddy gateway exposes PAODO's authenticated API and MCP interfaces
while denying UI and administrative routes.

Create a public DNS record for your API hostname pointing straight at the VPS's
public IPv4. The gateway must receive ports `80` and `443` itself to obtain and
renew its certificate, so it cannot sit behind another tunnel or reverse proxy.
Then set:

```env
WORKSPACE_API_DOMAIN=api.example.com
WORKSPACE_API_BIND_IP=<vps-public-ipv4>
```

The gateway needs exclusive use of ports `80` and `443` on that address. It can
coexist with an outbound UI tunnel or a UI proxy bound to another address, but
not with a proxy bound to the public address or `0.0.0.0` on those ports. Allow
inbound ports `80` and `443`, then use the configured hostname to reach it:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-api.yml \
  up -d
```

Everything outside the allowlist returns `404`. Two credentials reach what it
does expose, each created in a workspace's own panel over the private path and
shown exactly once:

- **Workspace API access** — a per-workspace key for
  `POST /api/workspaces/<id>/agent`.
- **Workspace MCP access** — a per-workspace secret for
  `POST /api/workspaces/<id>/mcp`.

Send them as `Authorization: Bearer <secret>`. Then confirm the gateway answers
over HTTPS and serves nothing outside the allowlist:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/   # expect 404
```

A response at all proves the certificate was issued. Test the bearer routes with
a real credential rather than a placeholder: a rejected bearer counts toward the
same per-IP brute-force lockout as a failed UI login — five within a minute
blocks the caller — and the gateway rewrites `CF-Connecting-IP` to the true
remote address, so the block lands on you, not on the gateway.

## Update

```bash
git pull

# Without the optional gateway:
docker compose up --build -d

# With the optional gateway:
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-api.yml \
  up --build -d
```

Always rebuild both `app` and `credproxy`: they now use separate images, and either side can change
the credential-injection contract. A scoped rebuild can leave the other side on stale code and
silently break per-workspace secret injection.

A change to `deploy/caddy/Caddyfile` alone needs no rebuild and no recreate — the directory is
mounted, so the container reads whatever the pull left there:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-api.yml \
  exec workspace-api caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Pass `--config` rather than relying on Caddy finding the file: `reload` searches the working
directory, not `/etc/caddy`, and a bare invocation exits with `input file required`.

Check that command's exit status, then confirm the new config is actually live by calling one route
it allows and one it refuses. A reload that rejects a config leaves the previous one serving and the
gateway up — the safe failure, but a quiet one, so success is worth proving rather than assuming.

Schema migrations run automatically at startup and cannot be reversed: once they
apply, the previous release refuses to start against the migrated database.

## Logs

Containers emit line-delimited JSON to stdout. Docker stores and rotates those
logs in its managed files on the host.

```bash
docker compose logs -f app
docker compose logs -f credproxy
docker compose logs -f --no-log-prefix app | jq -R 'fromjson? // .'
```

`--no-log-prefix` is required whenever you pipe into `jq`. Without it Compose
prefixes each line with `app-1  | `, which is not JSON, and `fromjson?` discards
every line — the filter returns nothing instead of failing.
