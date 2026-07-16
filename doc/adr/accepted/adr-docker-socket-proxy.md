Title: Restrict Docker daemon access via socket proxy

Status: Accepted

Context
docker-compose.yml previously mounted `/var/run/docker.sock` directly into the app container. Any exploited code path in the app would grant full Docker daemon access — equivalent to root on the VPS host. The app only needs a narrow set of Docker API operations (container lifecycle, network management, image build, exec, daemon info) to function.

Decision
Replace the raw socket mount with `tecnativa/docker-socket-proxy:0.3.0`. The proxy runs as a sidecar service on an `internal: true` compose network (`socket_proxy_net`) with only these feature groups enabled:

- `CONTAINERS: 1` — /containers/\*
- `IMAGES: 1` — /images/\*
- `NETWORKS: 1` — /networks/\*
- `BUILD: 1` — /build
- `INFO: 1` — /info
- `EXEC: 1` — /exec/\*
- `POST: 1` — enables POST and DELETE in addition to GET for all groups above

The app service sets `DOCKER_HOST=tcp://socket-proxy:2375`; the Docker CLI reads this automatically so no code changes are required. The proxy port is not exposed outside the compose stack.

Swarm, Secrets, Configs, Services, Plugins, Volumes (beyond initial `docker run` bind mount), and all other Docker API resources remain blocked.

Consequences

- Blast radius of app container compromise drops from full daemon → the 7 whitelisted API groups
- One extra network hop (TCP to proxy) — negligible latency impact for CLI commands
- `tecnativa/docker-socket-proxy` image must be kept up to date like any other dependency
- Adding new Docker operations in the future requires also enabling the corresponding proxy flag

Alternatives considered

- **Raw socket mount** — current state; rejected because it grants unrestricted daemon access
- **Docker-in-Docker (dind)** — nested daemon inside the app container; heavier, still grants daemon-equivalent power inside, and complicates image builds
- **Custom Nginx/HAProxy filter** — more control but significant maintenance burden; Tecnativa is a well-maintained, purpose-built solution

Notes
Related: `doc/adr/accepted/container-per-workspace-sandbox.md`.
