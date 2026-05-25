# ADR — Container-per-workspace sandbox

Status: Accepted

Context
Agents run arbitrary shell commands and need filesystem and runtime isolation to avoid leaking packages, processes, or files between workspaces.

Decision
Run each workspace inside its own Docker container with the workspace directory bind-mounted to `/workspace`. Containers are created lazily, stopped after an idle timeout, and restarted automatically on next use. Each container is assigned its own isolated bridge network. CPU and memory are capped per container (`CONTAINER_CPUS`, `CONTAINER_MEMORY`). The platform manages container lifecycle and network isolation so containers cannot reach each other directly.

Consequences
- Strong file and environment isolation; packages and processes do not leak between workspaces.
- Higher resource overhead per active workspace (container memory/CPU).
- Need container lifecycle management, image build/versioning, and operational guidance for host capacity.
- The platform accesses the host Docker daemon via a bind-mounted `/var/run/docker.sock`, giving the app process effective root on the host. This is a deliberate tradeoff for Docker-outside-of-Docker but must be factored into host security posture.

Alternatives considered
- Single host process with chroot-like isolation: lighter but weaker isolation and insufficient for runtime differences.
- VM per workspace: stronger isolation but too heavyweight for our use case.

## Clarification — Docker socket scope

The platform server creates containers on demand, but agents inside those containers cannot — because the socket that controls Docker is only given to the server, not to the containers it creates.
