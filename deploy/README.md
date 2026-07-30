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
git clone https://github.com/alxcls/PAODO_WS.git
cd PAODO_WS
cp .env.example .env
chmod 600 .env
nano .env
```

Set:

- at least one supported LLM provider key;
- `USERNAME` and `PASSWORD`;
- optional resource limits and timeouts.

## 3. Start PAODO

```bash
docker compose up --build -d
docker compose ps
```

The app listens on `127.0.0.1:3000` by default. Keep that port private.

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

The ingress must support WebSocket upgrades for `/ws`. PAODO Basic Auth remains
enabled through `USERNAME` and `PASSWORD`. It must also discard any
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

Everything outside the allowlist returns `404`. Each interface uses its own
credential: a workspace API key or workspace MCP secret.

## Update

```bash
git pull

# Without the optional gateway:
docker compose up --build -d

# With the optional gateway:
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-api.yml \
  up --build --force-recreate -d
```

Always rebuild the complete stack, never a single service: `app` and `credproxy`
run the same image, so a scoped rebuild leaves the sidecar on stale code and
silently breaks per-workspace secret injection. Recreating a gateway-enabled
stack also reloads changes to its mounted Caddy configuration.

## Logs and backup

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

Back up through the app rather than copying `/app/data/.paodo.db`: the database
runs in WAL mode, so a raw file copy can omit committed pages. Snapshot it, move
the copy off the host, then delete the same-volume snapshot.

```bash
docker compose exec -T app npm run backup:database -- /app/data/.paodo-backup.db
docker compose cp app:/app/data/.paodo-backup.db /path/to/off-host/paodo.db
docker compose exec -T app rm /app/data/.paodo-backup.db
```

Store backups outside the VPS, and take one before deploying a version that
introduces a schema migration — startup rolls back if a migration cannot
complete.
