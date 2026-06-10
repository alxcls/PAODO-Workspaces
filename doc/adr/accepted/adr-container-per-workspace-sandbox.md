# ADR — Container-per-workspace sandbox

Status: Accepted

Context
Agents run arbitrary shell commands and need filesystem and runtime isolation to avoid leaking packages, processes, or files between workspaces.

Decision
Run each workspace inside its own Docker container. All agent operations — both shell commands (`execute_command`) and file operations (`file_read`, `file_write`, `file_edit`, `list_directory`, `glob`) — are executed inside the container via `docker exec`. The workspace directory is mounted into the container using Docker 25+ volume subpath mounting (`--mount type=volume,source=<WORKSPACES_VOLUME_NAME>,target=/workspace,volume-subpath=<name>`), so the container's filesystem boundary is the workspace boundary at the OS level.

Containers are started eagerly when an agent session begins and stopped after an idle timeout (`CONTAINER_IDLE_MS`, default 10 min), restarting automatically on the next session. Each container has its own isolated bridge network. CPU and memory are capped per container (`CONTAINER_CPUS`, `CONTAINER_MEMORY`).

The `WORKSPACES_VOLUME_NAME` env var must be set to the runtime Docker volume name (compose project prefix + `_workspaces`). Run `docker volume ls | grep workspaces` to find the exact name. Requires Docker Engine ≥ 25.

Consequences
- Strong OS-level isolation for all agent operations; no app-level path check can be bypassed. "OS-level isolation" here means cross-workspace and host-filesystem isolation: other workspaces are never mounted in a container, and host paths are not visible inside it. It does not mean isolation from the container's own base image — a symlink inside `/workspace` pointing to a container-internal path (e.g. `/etc/passwd`) will still be followed. This is acceptable because the base image contains no sensitive data, and `execute_command` already gives the agent root access inside the container.
- The `realpath` + `startsWith` boundary check in file tools is no longer needed — see superseded `symlink-resolution-before-boundary-check.md`.
- Global workspace lock (`[R]`) is enforced at OS level via two complementary mechanisms:
  - **File tools** (`file_read`, `file_write`, `file_edit`, `list_directory`, `glob`): the workspace volume is remounted with `MS_RDONLY` (`:ro` / `,readonly`) when locked, blocking all writes regardless of user or UID mapping. This is necessary because VirtioFS bind mounts on macOS ignore container user permissions.
  - **Shell commands** (`execute_command`): additionally drops to `-u agent` (UID 999) in `docker exec` so the restricted user cannot write to other locations in the container (e.g. installing packages system-wide).
- Higher resource overhead per active workspace (container memory/CPU).
- Need container lifecycle management, image build/versioning, and operational guidance for host capacity.
- The platform accesses the host Docker daemon via a socket proxy, limiting blast radius to the 7 whitelisted API groups — see [`docker-socket-proxy.md`](docker-socket-proxy.md).

Alternatives considered
- Single host process with chroot-like isolation: lighter but weaker isolation and insufficient for runtime differences.
- VM per workspace: stronger isolation but too heavyweight for our use case.

## Clarification — Docker socket scope

The platform server creates containers on demand, but agents inside those containers cannot — because the socket that controls Docker is only given to the server, not to the containers it creates.
