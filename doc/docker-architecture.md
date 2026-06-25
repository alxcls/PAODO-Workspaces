# Docker Architecture

---

## Architecture

```
  HOST MACHINE
  +--------------------------------------------------------------+
  |                                                              |
  |  [ Docker Daemon ]                                           |
  |         ^                                                    |
  |         | (1) socket                                         |
  |         |                                                    |
  |  [ PAODO WS App ]               -- container                |
  |         |                                                    |
  |         | (2) creates siblings                               |
  |         |                                                    |
  |  [Bakery]   [Supplier]   [Accounts]  ...  -- containers     |
  |      |           |           |                               |
  |      | (3)       | (3)       | (3)   bind mounts            |
  |      |           |           |                               |
  |  /data/     /data/     /data/          -- host disk      |
  |  bakery/     supplier/   accounts/                          |
  |                                                              |
  +--------------------------------------------------------------+
```

**(1) socket** — the app sends instructions to the Docker Daemon
through a special file on the host (`/var/run/docker.sock`).
Think of it as a private phone line between the app and Docker.

**(2) siblings** — workspace containers are created by the app
but live at the same level, not inside it.
The app never shares a network with them — it controls them only via the socket.

**(3) bind mount** — each container sees a folder from the host disk
as if it were its own (`/workspace` inside = `/data/<name>/` on disk).
Files are never actually inside the container.
The container can be deleted or rebuilt with zero data loss.

**isolation** — each workspace runs on its own private network.
Can reach the internet (install packages, run curl, etc.).
Cannot reach any other workspace container.
Its dev server (container port 8080) is published only to the app —
bound to a specific host interface (`127.0.0.1` in local dev, the Docker
bridge gateway in production), never `0.0.0.0` — so nothing else on the
host or tailnet can reach it directly. The app bridges browser previews
to it through `/api/workspaces/:id/proxy`; see
`doc/adr/accepted/adr-container-server-proxy.md`.

---

## Lifecycle

The same rule applies to every caller — browser, agent call, or external API.
A workspace wakes on any incoming command and sleeps after 10 minutes of silence.

```
  Any command arrives
  (browser, agent call, external API)
               |
               v
  +----------------------------------------------------+
  |                    WAKING UP                       |
  |  network created  *  container started  (~400 ms)  |
  +----------------------------------------------------+
               |
               v
         +----------+
         |  AWAKE   |  <--  idle timer resets on every command
         |  has RAM |
         |  has net |
         +----------+
               |
               | no command for 10 minutes
               v
  +----------------------------------------------------+
  |                    ASLEEP                          |
  |  network removed  *  container stopped             |
  |  0 RAM  *  0 network rules  *  files safe on disk  |
  +----------------------------------------------------+
               |
               | next command arrives --> wakes up again (~400 ms)
               v
           (repeat)
```
