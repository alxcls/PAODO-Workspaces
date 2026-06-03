# ADR — Workspace dependency installation (fat base image + apt broker)

Status: Proposed

## Context

The workspace agent runs as non-root `developer` (UID 1001) and cannot compose a root command — the foundation of the restriction model. It must still be autonomous enough to install whatever a project needs.

**User-space installs already work with no special mechanism:**
- Language versions: `nvm`, `pyenv`, `asdf` (pre-installed in `Dockerfile.workspace`)
- Project dependencies: `pip install`, `npm install`, `cargo build`, `go get`, `bundle install`, …

**The single gap** is system shared libraries (`.so` files, `-dev` headers, system binaries like `ffmpeg`) that `apt` writes into root-owned `/usr`. Granting the agent root would collapse the restriction model.

**Why broker installs persist:** workspace containers are `docker stop`/`start`-ed, never `docker rm`-ed between sessions. The container writable layer survives idle cycles, reboots, and daemon restarts. An apt install into `/usr` is permanent for the life of the workspace — lost only on workspace deletion (`docker rm`).

## Decision

### Layer 1 — Fat base image

`Dockerfile.workspace` pre-installs the common system surface at build time: `build-essential`, frequent `-dev` libraries, and headless browser dependencies. Covers ~90% of projects with no runtime action. Heavy/stable layers go early in the Dockerfile to maximise layer cache reuse. Image budget: ≤ ~4 GB.

### Layer 2 — Server-mediated apt broker

For anything not pre-baked, the agent calls one tool:

```
install_system_package(packages: string[])
```

The server builds the exact `apt-get install -y` argv and runs it via `docker exec -u root` — the same root path as `lib/infra/osLock.ts`. The agent never holds root and never composes the command.

**Package policy:** official Ubuntu repositories only. No `add-apt-repository`, no `sources.list` edits, no local `.deb` installs. This is the same archive already trusted unconditionally in the Dockerfile — no new trust is extended.

**After every install**, `reconcileOsPermissions` runs to re-assert root-ownership on all locked, hidden, and privileged paths. Apt maintainer scripts run as root and could in theory touch `/workspace` ownership; the reconcile pass closes that window at negligible cost.

Calls are serialized per container (dpkg global lock).

### Layer 3 — Image rebuild

When a gap recurs across workspaces, promote the package into Layer 1. Human-in-the-loop, not a runtime mechanism.

## Agent guidance (system prompt)

> To install a system library — e.g. when a command fails with a missing `.so`, a `pkg-config` error, or a missing header — call `install_system_package`. Do not use `apt` or `sudo` directly; they will not work.

The agent reacts to the error (try → fail → fix), maps the `.so` name to the apt package (standard Linux knowledge), and calls the tool. No upfront prediction needed.

## Consequences

- Agent is fully autonomous over dependency installation using apt-native idioms. Restriction model unchanged.
- Broker installs are permanent for the workspace; reclaimed only on `docker rm`.
- If a container is ever force-recreated (ops edge case), broker installs in `/usr` are lost while `/workspace` survives. Mitigation: add an optional declarative package manifest reconciled on start. Deferred until needed.
- Per-workspace disk growth from accumulated apt installs must be monitored.

## Alternatives rejected

- **Curated allowlist:** marginal security gain over official-repo pinning alone; adds curation burden. The trust boundary is the Ubuntu archive, not a name list.
- **`sudo apt` for the agent:** apt CLI options (`-o Dpkg::Pre-Invoke=…`, `install ./x.deb`) bypass sudoers rules and allow arbitrary root commands. Hard to constrain safely.
- **Grant agent root / userns remapping:** collapses the restriction model (agent can rewrite protected ownership bits). Rejected.
- **Nix / conda / micromamba:** fights apt-native model training, risks ABI conflicts. Rejected as primary path.

## Notes

- Depends on / does not modify: `agent-restriction-model.md`, `container-per-workspace-sandbox.md`.
- Root path reuse: `lib/infra/osLock.ts` (`runRoot`); reconcile: `reconcileOsPermissions`; lifecycle: `lib/infra/containerManager.ts`.
- Broker surface to build: `lib/agent/tools/installSystemPackage.ts`, route `app/api/workspaces/[id]/apt/route.ts`.
