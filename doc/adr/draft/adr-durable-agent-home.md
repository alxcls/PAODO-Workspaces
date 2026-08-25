# ADR — The agent's home is durable storage, not container scratch

Status: Proposed

Context

A workspace persists exactly one thing reliably: `/workspace`, which is mounted from the workspaces
volume. Everything the agent _installs_ lands elsewhere, in the container's writable layer, and is
destroyed by `docker rm`:

- npm globals → `~/.nvm/versions/node/<v>/lib/node_modules`
- pip packages → `~/.local/lib/python3.12/site-packages` (non-root pip falls back to user-site)
- extra Node/Python versions → `~/.nvm/versions`, `~/.pyenv/versions` — the latter compiles for minutes
- downloaded installers (rustup, go, sdkman) → `~/.cargo`, `~/go`, `~/.sdkman`
- apt packages → `/usr`, `/etc`, `/var/lib/dpkg`

Everything on that list except apt lives under `/home/dev`. This has three consequences we are
already paying for:

1. **Containers can never be recreated.** `containerManager.ts` says so explicitly, and it is correct
   given the storage layout — recreating one destroys the workspace's real content.
2. **No workspace ever receives an updated base image.** Production containers report a ~963MB base
   while the current image is 1.29GB; they have been running an older image for months.
3. **Backups are silently partial.** Copying `/workspace` to S3 and restoring it gives you a
   workspace with all the user's files and none of their tools.

Measured on production: one workspace holds 1.87GB of installed material with no copy anywhere. The
workspace running PostgreSQL keeps its _database_ safely in `/workspace/pgdata` — but only because
the non-root agent could not write `/var/lib/postgresql` and had no other option. The program itself
sits in the disposable layer.

Decision

**Mount `/home/dev` from the workspaces volume, per workspace**, at
`<WORKSPACES_ROOT>/.homes/<workspaceId>` — the same durable storage and the same mount style
`/workspace` already uses, dot-prefixed like `.proxy-ca` and `.versioning` so it is never mistaken
for a workspace.

The image ships ~250MB under `/home/dev` (nvm's Node, pyenv) that an empty mount would hide, leaving
a workspace with no node and no python. So on first create only, a throwaway root container copies
that tree in with `cp -a`, preserving uid 1000 so the agent can still write its own home. This is
**fatal on failure**: a container started on an empty home presents as "node is missing" rather than
"setup failed".

apt is deliberately **not** addressed here. It scatters a single install across `/usr`, `/etc` and
`/var/lib/dpkg` with a package database that must stay in sync with the filesystem, so it cannot be
relocated onto a volume. It is also the cheapest thing to reconstruct: the 1.87GB workspace above is
98 package names. Recording those is separate, follow-up work.

Consequences

- **Everywhere the agent can write now survives**, so the class of bug where it picks a durable-
  looking path and silently loses the work disappears. `/tmp` remains scratch by design; the system
  prompt names it as the one place lasting data must not go.
- **This is architecture, not instruction, and that is the point.** `rustup` and `pyenv` hardcode
  `$HOME` and will ignore any prompt rule. A mount does not need maintaining, cannot be forgotten,
  and does not compete for the agent's attention.
- **Containers become disposable again**, which unblocks rolling image updates to existing
  workspaces — impossible today. This ADR does not itself change the never-recreate policy in
  `containerManager.ts`; it removes the reason that policy existed.
- **Restore reuses the everyday path.** Recovering a workspace is `docker run` with two mounts, the
  same code that runs on every create, rather than a replay script that rots until first use.
- **Cost: ~250MB per workspace before the agent installs anything.** Deleting a workspace must remove
  the home directory or that leaks per deletion — handled in `workspaceDeleteDeps.ts`.
- **Existing workspaces are deliberately left alone.** No migration, no rescue path, no branching on
  whether a container predates this. An old container keeps running as-is; if it is ever recreated it
  comes back durable and the agent reinstalls what it needs.
- **Backups become meaningful but not yet complete**: `/workspace` plus `/home/dev` covers everything
  except apt, which needs the follow-up package list before an S3 restore is whole.

Alternatives considered

- **Put everything under `/workspace`.** Rejected: that directory is the user's file tree — browsed in
  the UI, watched by chokidar, and git-snapshotted on every run. A compiled Python and several Node
  versions in there would wreck the file browser and bloat every snapshot.
- **Tell the agent where to install things.** Rejected as the primary mechanism: it cannot work for
  installers that hardcode `$HOME`, and a prompt rule is the part you have to keep re-proving. One
  sentence still covers the residual judgment call (user-visible data → `/workspace`, never `/tmp`).
- **`docker commit` each container and push the image.** Rejected: gigabytes per workspace, slow, and
  it inverts the model where one base image is shared by all.
- **Snapshot the whole writable layer.** Rejected: it would faithfully preserve junk. The PostgreSQL
  workspace's layer holds a 992-file Debian cluster that is unusable and will never be started.

Notes

- Related: [container-per-workspace-sandbox.md](../accepted/adr-container-per-workspace-sandbox.md),
  whose "what cannot change without recreating the container" list includes mounts — so this change
  reaches only newly created containers, by design.
- Verified on the production image before implementing: `cp -a` as root preserves 1000:1000 ownership
  on Linux, and the copied tree is 251MB with Node present.
