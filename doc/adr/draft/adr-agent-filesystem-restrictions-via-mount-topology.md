# ADR — Agent file restrictions via app-composed mount topology

Status: Proposed

Supersedes two prior drafts — `adr-fuse-agent-filesystem-view.md` (filtered FUSE view) and
`adr-agent-privilege-and-locked-files.md` (three in-container UIDs) — and the abandoned branches behind
them (`feat/agent-privilege-model`, `permission-model`). Feasibility confirmed by a spike (see Notes).

Context

The goal: the **user** decides what the agent can see and edit, then lets it run autonomously. Three
capabilities are required:

- **Deny-read** files/folders — the agent knows the path exists but cannot read its bytes. (Name
  visibility is intended: the agent can reason about a file and trigger a privileged script against
  it; only the content is withheld.)
- **Deny-edit** files/folders — the agent can read but cannot write/replace/delete.
- **Privileged scripts** the agent can *trigger* — a script may read deny-read and write deny-edit
  paths, while the agent that launched it gains no such access itself.

Two trusted principals keep full access: the **human** (app UI/API) and **user-approved privileged
scripts**. Only the **agent** is untrusted. This is a 2-tier model (restrict one principal), not a
3-identity ACL on shared files — the reframe the prior attempts missed.

Decisive facts about how this codebase reaches files (verified against the code):

1. **The human/app reads the workspace host volume directly** via `fs.readFile`/`fs.readdir`
   ([files/content/route.ts](../../app/api/workspaces/[id]/files/content/route.ts)) — never through
   the agent's container.
2. **The agent reaches files only via `docker exec` into `ws_<id>` as uid 1000** — both the shell
   (`execute_command`) and the file tools (`file_read` runs `cat`/`sed` *inside* the container). See
   [buildTools.ts](../../lib/agent/buildTools.ts), [fileRead.ts](../../lib/agent/tools/fileRead.ts).
3. **The app already composes the container's mounts** at `docker run` (`buildVolumeArg`,
   [containerManager.ts](../../lib/infra/docker/containerManager.ts)).
4. **The container is hardened**: `--cap-drop ALL` + minimal add-back + `no-new-privileges:true`. No
   `SYS_ADMIN`, no `/dev/fuse`. A `chown -R 1000:1000 /workspace` sweep runs on every (re)create.
5. **There is no permission store yet** — greenfield (prior drafts wrongly called it "existing").
6. **The app reaches Docker only through the socket proxy**
   ([adr-docker-socket-proxy.md](../accepted/adr-docker-socket-proxy.md)); no host shell, so it
   cannot mount a host filesystem (FUSE/overlay) outside the Docker API.

Facts 1+2 are the basis: **human and agent already use separate access paths**, so we can restrict the
agent's view without touching the human's — no per-file ownership, reconciliation, or new caps.

Decision

**Enforcement is the agent container's mount topology, composed by the app from the permission store at
container (re)create time.** The store is the source of truth; the mounts *are* the policy. No per-file
`chown`/`chmod`, no reconciliation engine. Base mount stays the workspace, read-write. The app layers:

- **Deny-read file** → bind-mount a **read-only stub over the path** (one line:
  `[restricted: content withheld by workspace policy]`). The name stays in `ls`; any read returns the
  stub, so the agent learns the file exists *and* is blocked. **Hardlinks:** a per-path mount cannot
  mask an inode's other links (spike-confirmed leak). So flagging deny-read **refuses a file with
  `st_nlink > 1`** with a clear error, or **copy-breaks** the link first; symlinks resolve through the
  mount and are safe.
- **Deny-read folder** → mount a **read-only bind of a stub dir** (containing only a `README`) over the
  path: real entries vanish, the name stays, the README explains. (Chosen over a `tmpfs`, which when
  read-only cannot be pre-seeded with the README — spike-confirmed.)
- **Deny-edit file/folder** → bind-mount the path **`:ro` as its own mountpoint** over the RW base.
  Load-bearing two ways: writes/truncate return `EROFS`, **and** because the path is a mountpoint,
  `rm`/`mv`/replace from the writable parent return `EBUSY` (a read-only *parent* alone would not stop
  child deletion). Both kernel-enforced and spike-confirmed.
- Everything else passes through read-write.

**Two render topologies, one policy (dev bind vs prod volume-subpath).** The rows above describe the
*mechanics*; how the daemon reaches each source depends on the deployment. In **dev** the app runs on
the host, so sources are host paths bound directly (`-v src:dst:ro`). In **production** the workspace
lives in a Docker named volume the daemon cannot address by host path — so the same mounts are emitted
as **`--mount type=volume,…,volume-subpath=…,readonly`**, nested under the base `/workspace` mount
(Docker orders mounts by target depth, so children mount over the parent). This works because the
workspace files **and** the deny-read stubs both live inside that one volume (stubs under
`.agent-permissions/<id>/stubs/…`, relative to `WORKSPACES_ROOT`, which *is* the volume). The policy
core (`buildRestrictionMounts`) takes a `topology` descriptor and renders either syntax; all the
fail-closed rules are identical. File-level `volume-subpath` (not just dir-level, as the base mount
uses) was validated against a real daemon, and an integration test drives `docker run` in volume mode.

**Why arbitrary shell cannot bypass this.** `execute_command` runs arbitrary `bash -c` as uid 1000 —
preserved, and precisely why enforcement must be kernel-level, not in tool code (the shell defeats any
tool check by `cat`/`python`-ing the file). Yet uid 1000 cannot alter the topology: `umount`/`unshare
-m` need `CAP_SYS_ADMIN`, dropped by `cap-drop ALL` (spike: both denied); `no-new-privileges` blocks
any setuid path to regain it; and the container mounts **no docker socket**, so the agent cannot
`docker exec`/`run` itself as another uid. The topology is set from outside the agent's reach (app →
socket proxy → `docker run`). This is also why FUSE is rejected: it re-adds `SYS_ADMIN`, the one cap
that unravels every row above.

**Flips persist the writable layer (commit-on-flip).** Mounts are fixed at `docker run` and
immutable on a live container without `CAP_SYS_ADMIN`, so a topology flip means recreating the
container — which normally destroys the writable layer (apt `/usr`,`/var`,`/etc`; system pip;
`/home/dev`). To honor the hard requirement that **installed dependencies persist**, a flip is
`docker commit ws_<id> → rm → run <snapshot>`: the snapshot becomes the run image, so deps survive;
only live processes and unexported env are lost. Trigger split (distinct paths in `_ensureContainer`,
not a conflict): a **flip** recreates from the per-workspace snapshot (deps kept); a
**`Dockerfile.workspace` hash change** still recreates from the fresh base (deps rebuild) so platform
updates land. Spike-confirmed (Notes). **Socket-proxy requirement:** `docker commit` is a distinct
proxy endpoint — the proxy must set `COMMIT: 1` (alongside `CONTAINERS`/`IMAGES`/`POST`), or the commit
is `403`-forbidden and deps silently rebuild from base on every flip. Best-effort: a failed commit logs
and falls back to the base image rather than blocking the flip.

**Privileged execution — app-brokered, runs against the host volume (privilege by location).** The
agent invokes a tool that supplies **only a registered script path** — no command string, no
agent-supplied args, no shell. The app runs the script against the **host volume** (the human's
full-access path), where deny-read/deny-edit don't apply. Privilege is bound to *where* the script
runs, not to a uid or flag — so the same script through the agent's restricted shell is inert.

Closure rule (carried from the rejected `privd` draft): a privileged script may execute code **only**
from agent-immutable (deny-edit) paths and take **no agent-controlled path argument** — else it is a
confused deputy. Partly app-enforceable (register + lock the script and its dir); the rest is authoring
discipline. The fixed-argv broker makes it tractable.

**Defense in depth (not the boundary).** The file tools (`file_read`, `file_edit`, `file_write`,
`list_directory`, `glob`) also consult the store and fail **closed** for clean agent-facing errors.
Bypassable alone (the shell reaches anything uid 1000 can) — the mount topology is the boundary; tool
checks are UX/backstop.

**Fail-closed everywhere.** If the store can't be resolved at container build, deny (don't mount the
ambiguous path RW). Prior code logged-and-continued — failed open. **Keying is user-only:** marking
paths and registering scripts are file-tree actions; the agent has **no tool** to grant itself
privilege or clear a flag.

Permission store: a new per-workspace JSON file (e.g. `.agent-permissions/<workspaceId>.json` with
`denyRead[]`, `denyEdit[]`, `privilegedScripts[]`). Reuse only the file-tree badge **icons** (eye /
lock / key) from the abandoned branch UI.

Consequences

- **Non-regression is the headline.** uid stays 1000, so the chown sweep, `no-new-privileges`, and
  `cap-drop ALL` are untouched — **no new capability granted**. Human reads are already host-fs. No
  reconciliation engine to drift.
- **Hidden content is unexfiltratable** — it is never in the agent's mount namespace (the FUSE draft's
  guarantee, without FUSE). **Deny-edit is kernel-hard** — `:ro` rejects writes from any process at
  any uid, closing the "agent writes a script to bypass tool checks" hole.
- **Write path needs no change for the common case.** The human write already uses `fs.writeFile`
  ([route.ts](../../app/api/workspaces/[id]/files/content/route.ts)); only the *legacy* `tee`-into-
  container fallback (for pre-migration root-owned files) would hit `EROFS` on a deny-edit path — drop
  that fallback or route it host-side.
- **Cost — flips recreate the container** (mounts fixed at `docker run`): seconds of latency plus a
  `docker commit` (more seconds + a per-workspace snapshot image to store and GC). Live processes and
  unexported env are lost; **deps persist** via the snapshot. Acceptable for "configure, then run
  autonomously"; would hurt if flips became a frequent hot path (they aren't).
- **Path-keyed policy is brittle to renames** (the sharpest open gap). The store flags *paths*, but
  the agent's shell can `mv` a parent dir, orphaning the flag — on next recreate the mount targets a
  path the file no longer occupies, silently unprotecting it. Mitigation: re-resolve the store against
  the tree at each flip and **refuse/repair an `mv` that would orphan a flag** (the file tools can
  block it; a raw shell `mv` cannot be caught until the next resolve, so deny-edit the flagged path's
  *parent* when strong guarantees are needed). Inode-pinning is impossible with path mounts.
- **Filenames remain visible** (intended). A name can leak (`prod-db-password.txt`); content is
  protected, names are not — mitigate by naming innocuously or nesting under a generic deny-read folder.
- **Deny-read forbids multi-linked files** (`nlink>1` refused/copy-broken) — a rare usability cost,
  the honest price of path-based masking. Many scattered paths also mean many mounts: fine for a
  handful, ugly at hundreds (rare).
- **Privileged-script residual trust.** Once a keyed path exists, the agent can do exactly what that
  script permits — not airtight against a script that is itself a confused deputy (bounded by the
  closure rule + fixed argv). User approval is the `sudo` trust model, out of scope.
- **Hard floor unchanged.** A kernel exploit or socket escape defeats this, as today; unlike FUSE,
  nothing here *raises* escape probability. In scope only for the prompt-injected-agent threat.
- **Needs a bypass test suite** driven through `execute_command` (not just the file tools): `EROFS`,
  `EBUSY`, `umount`/`unshare -m` denial, deny-read via hardlink **and** symlink, no docker socket,
  flag-flip recreate, **and commit-on-flip dep persistence** (apt/pip/home survive a flip, base-hash
  change rebuilds). The prior branches had zero tests.

Alternatives considered

- **Filtered FUSE view.** Rejected for this deployment: needs `CAP_SYS_ADMIN` + `/dev/fuse`, and with
  no host shell the mount can't be held on a trusted side — so it means granting near-root to the very
  container we're containing, *lowering* the escape floor. Only real edges: instant flips and clean
  name-hiding. Keep as fallback **only if** those become hard requirements and `SYS_ADMIN` is accepted.
- **Three in-container UIDs + per-file chown/chmod.** Rejected: reintroduces the `osLock`
  reconciliation that drifted and failed open (cause of both prior failures), collides with the chown
  sweep, and forces the human API to re-broker every locked op as a second uid.
- **OverlayFS whiteouts / gVisor / Kata.** OverlayFS `mount` needs `CAP_SYS_ADMIN` (same blocker as
  FUSE); a syscall-sandbox runtime would strengthen isolation without it but is a far larger commitment
  than composing mounts the app already builds. Revisit if the runtime moves for other reasons.

Notes

- Feasibility spike (under real hardening) confirmed `EROFS`/`EBUSY` on deny-edit, stub + ro-bind-dir
  masking, `umount`/`unshare -m` denial, and the **hardlink leak** that drove the `nlink>1` rule.
- Persistence spike confirmed **commit-on-flip**: with the real cap set, `apt install jq` + a
  `/home/dev` marker survive a `commit → rm → run <snapshot>` recreate that *also* adds a new
  deny-edit `:ro` mount (deps kept **and** topology flipped in one recreate); a plain recreate from
  base loses them. So `--cap-drop ALL` must keep its `SETUID`/`SETGID` add-backs or apt's `_apt`
  privilege-drop fails.
- Related: [adr-container-per-workspace-sandbox.md](../accepted/adr-container-per-workspace-sandbox.md),
  [adr-docker-socket-proxy.md](../accepted/adr-docker-socket-proxy.md),
  [prd-workspace-secrets.md](../../prd/draft/prd-workspace-secrets.md).
- Implementation seams: `buildVolumeArg` + `_ensureContainer`
  ([containerManager.ts](../../lib/infra/docker/containerManager.ts)) for mount layout and
  recreate-on-flip; `buildTools` ([buildTools.ts](../../lib/agent/buildTools.ts)) for tool checks and
  the broker tool; the human write path for dropping the legacy `tee` fallback.
