# ADR — Agent privilege model: three roles, locked/hidden files, and brokered privileged scripts

Status: Proposed

Context

Today the agent runs inside its workspace container as a single non-root user (`dev`, uid 1000),
confined to `/workspace` (the only bind-mounted, persistent path). This confinement is strong and
**fails closed**: a file the agent shouldn't reach, it deterministically cannot. Verified in practice —
an agent "sniff" of the container could read everything world-readable (`/etc/passwd`, `/proc/self/environ`,
network metadata) but was denied `/etc/shadow`. Enumeration is not access; the OS `uid + mode` check holds.

Two needs push beyond a single role:

1. **Hide data from the agent at rest.** There is no safe way to keep secrets/datasets in a workspace
   the agent cannot read. Anything in `/workspace` owned by `dev` is readable by the agent (and therefore
   can land in the LLM context, tool output, or A2A messages). See the related
   [prd-workspace-secrets.md](../../prd/draft/prd-workspace-secrets.md).
2. **Let the agent _trigger_ privileged work without _seeing_ the credential/data.** A workflow may need a
   credential or a locked file used by a command, while the agent itself must never read it.

A prior implementation attempt exists on two branches (`feat/agent-privilege-model`, later
`permission-model` — the "secured" branch). It was not merged. This ADR records the model we will build,
what to salvage from those branches, and **why the previous attempt didn't work** so it is not rebuilt the
same way.

Key constraint discovered during design: **you cannot create a privilege boundary between two principals
that share a uid.** To the kernel, "the agent's shell" and "a script the agent launches" are both uid 1000 —
the same principal. Any "only privileged scripts may do X" gate enforced _inside_ the container is
userspace-checkable and therefore agent-forgeable (a confused-deputy). A real boundary needs a _second
principal the agent cannot impersonate_: a different uid set by the trusted app via `docker exec -u`, or the
app itself across the container boundary. `no-new-privileges:true` (already set) disables setuid, so the
agent can never elevate a script it runs — which is exactly what makes read/write-deny trustworthy, and
exactly what makes an in-container "privileged script" impossible to bootstrap from the agent's side.

Decision

**1. Three container roles. No fourth.**

| Role    | uid  | May touch                                                          | Reachable by                      |
| ------- | ---- | ------------------------------------------------------------------ | --------------------------------- |
| `dev`   | 1000 | `/workspace` non-locked files; world-readable system files         | agent directly                    |
| `privd` | 1001 | the above **+ locked/hidden files in `/workspace`** (it owns them) | agent **only via a keyed script** |
| `root`  | 0    | everything (system)                                                | app **only via `apt_install`**    |

`privd` is an ordinary Unix user/group (no caps, no sudo, `nologin` shell). Its _only_ power is that it
**owns the locked/hidden files**. It is deliberately scoped to in-workspace locked data and grants **zero**
reach outside `/workspace` — it is not root, owns nothing in `/etc` `/var` `/usr`, and otherwise has exactly
the access any unprivileged user has (world-readable only). Do not let `privd` ownership creep outside the
workspace; system-level needs go through `root`/`apt_install`, never `privd`.

**2. File state — three independent flags, applied as OS ownership + mode.**

- **Locked (write-deny):** `privd:privd 0644` — agent may read, cannot write/replace.
- **Hidden + locked (read+write-deny):** `privd:privd 0600` — agent cannot read or write.
- **Keyed (privileged script):** the script and its directory are locked (`privd`-owned, agent-immutable),
  and the script is registered in the app-side privilege store. Only the **user** can key a script
  (file-tree key icon); the agent has no tool to grant privilege.

A reconciliation step (`osLock`) applies the intended ownership/mode inside the container via the app's
root exec. Files _created by_ a `privd`-run script are `privd`-owned → automatically locked, no "reclaim"
chown needed.

**3. Privileged execution — explicit broker only, run as `privd` (not root).**

The agent invokes a keyed script through a dedicated tool that supplies **only a script path**. The app
composes a **fixed argv** and runs it as `privd`:

```
docker exec -u 1001 -w /workspace ws_<id> <fixed interpreter> /workspace/<keyed-relpath>
```

No command string, no agent-supplied arguments, no shell, no command-line parsing. The interpreter is
derived server-side from the file extension. This is the `runPrivilegedScript` design already present on the
branch — it is the path we keep.

**4. User access to locked/hidden files is an app-auth boundary, not a container uid.**

The app server and the agent both run as uid 1000 (in _different_ containers), so the user/agent split
**cannot** be a Unix uid. The human never has a shell in the workspace container. User reads/writes of
locked/hidden files go through **authenticated app routes**, which broker the op as `privd` via
`docker exec -u 1001`. The agent's file tools check the lock/hidden flags and are denied. The agent must
have **no tool** that maps to the user's privileged-file route.

**5. `apt_install` remains the only `root` door**, app-mediated, accepting **package-name tokens only**
(never arbitrary apt flags — `-o APT::Update::Pre-Invoke=...` etc. would turn it into arbitrary root exec).
Prefer baking routine packages into `Dockerfile.workspace` so the root door rarely opens; stop/start
preserves the writable layer, so installs persist until the image is rebuilt.

**Invariants that make this safe (the load-bearing rules):**

1. Keying is **user-only**; the agent has no grant tool.
2. **Closure rule:** a keyed script may execute code **only** from locked (agent-immutable) paths, and must
   take **no agent-controlled path argument**. _(Partly app-enforceable — lock the script's whole directory;
   the rest is authoring discipline.)_
3. **Fixed invocation:** `docker exec -u privd <fixed interpreter> <fixed path>` — no parsing, no agent args.
4. `apt_install` accepts package names only.
5. `osLock` reconciliation must converge ownership/mode with no drift.

Consequences

- **Deny-read / deny-write / deny-create is unconditionally airtight on its own.** With no root-capable
  actor in the agent's reach, the agent simply cannot cross it (kernel-enforced, proven against `/etc/shadow`).
- **Adding the privileged path makes airtightness conditional.** A keyed script runs as `privd`, which can
  read/write the locked files. So the guarantee becomes: _the agent can do, as `privd`, exactly what the keyed
  scripts permit — and nothing more._ It is **not** airtight against a keyed script that is itself a confused
  deputy (runs agent-writable code, or opens an agent-controlled path).
- **Choosing `privd` over root bounds the blast radius.** A hijacked keyed script can reach **only the locked
  workspace files**, not system files, not other workspaces, not the container's root. With root the same
  mistake = full container compromise. This is the single biggest safety lever and the reason we reject root
  for keyed scripts.
- **Confidence (design, not implementation):** mechanism enforceable ≈ 9/10; safe ≈ 8/10 _if_ keyed scripts
  are self-contained and locked top-to-bottom; drops sharply if the closure rule is violated. The residual
  trust surface is small, explicit, and `privd`-bounded.
- **User-approval risk is acceptable and out of scope.** A user keying a script that does damage is the same
  trust model as `sudo` — their call, their container. The concern this ADR guards against is _different_: the
  agent hijacking a script the user reasonably believed was safe, via its inputs/dependencies.
- Operational: `privd`-owned outputs need no chown reclaim; the app holds no elevated _file_ access in its own
  process (it brokers via `docker exec`); routine packages should move into the image.

Why the previous attempt (the "secured" branch) didn't work

The branches got the **storage and registry side right** but failed on the **execution side** and on **scope**:

1. **Transparent auto-routing in `execCommand` was the core mistake.** Instead of an explicit broker, the
   branch tried to make privilege invisible: the agent typed a normal shell command and the server _parsed the
   command line_ (`resolveProgramRel` + `lexCommand`) to infer whether the real program was a keyed script,
   then ran the whole invocation as root. This makes the security boundary depend on the server's lexer
   matching bash exactly, forever — an unwinnable arms race. The git history is the confession:
   _"gate privileged execution on the resolved program, not any token"_, _"resolve privileged program through
   launcher chains (npx tsx, ts-node)"_, _"run privileged commands as root via bash -c"_. Every fix uncovered
   another bypass/breakage (env-prefix assignments, `command`/`exec`/`env` wrappers, quoting, operators).
2. **It ran privileged scripts as `root` with secrets injected** → maximal confused-deputy blast radius, plus
   a fragile "reclaim root-owned files after privileged script runs" cleanup step.
3. **No defense against the transitive confused-deputy.** The lock was on the script _file_, not on the
   _closure_ of everything it executes. A locked keyed script that runs an agent-writable `main.py` still hands
   the agent privilege. This case was never closed.
4. **Scope/complexity churn.** ≈ +4.8k/−8.5k lines, three coupled controls, and an `osLock` reconciliation
   engine that drifted — _"fix 9 permission-model bugs"_, _"Enforce Key/Eye invariants and fix un-key drift"_,
   _"Enforce OS permission sync and clean drifted ownership"_. The per-toggle ownership/mode sync was the main
   bug source.
5. **Deployment smell:** keyed-script writes required a host sysctl change (`fs.protected_regular=0`),
   coupling the feature to host configuration.

What to salvage

**Only the file-tree badge icons (the "logos") — nothing else.** Reuse the eye (hidden), key (privileged),
and lock (locked) visual assets from the branch UI. Everything else — stores, broker, `osLock`, API routes,
tools — is to be **built fresh from this ADR**, not copied from `feat/agent-privilege-model` /
`permission-model`.

This is deliberate. The branch code carries the rejected approach baked in (root execution, command-line
auto-routing, env-injected secrets, the drifting reconciliation). Salvaging individual files would drag that
shape — and its assumptions — into the new implementation and confuse whoever builds it. Take the icons,
read this ADR, and implement the model clean.

Do **not** carry over (these are the rejected approach, see "Why the previous attempt didn't work"):

- the `execCommand` privilege auto-routing and command-line parsing (`resolveProgramRel`, operator/quote
  refusal, launcher-chain resolution)
- running keyed scripts as `root`, secret env-injection, and the root-owned-file reclaim step
- the `fs.protected_regular=0` host requirement

Alternatives considered

- **In-container "privileged script" gated by an in-container marker** (filename/attribute/marker file).
  Rejected: agent shares uid 1000, can read/copy/forge the marker — confused-deputy, unenforceable.
- **Setuid wrapper binaries.** Rejected: `no-new-privileges:true` disables setuid; a setuid wrapper stays
  uid 1000 and also can't read the locked file. (And keeping no-new-privileges is what makes read-deny solid.)
- **Privileged scripts as `root`** (the branch's choice). Rejected: maximal blast radius for a confused-deputy
  slip; `privd` gives the same capability bounded to the locked files.
- **Env-injected secrets via `docker run -e`** (the secrets PRD's mechanism). Rejected: env vars are dumpable
  from any shell (`env`, `cat /proc/self/environ`), so they're readable by the agent — good storage isolation
  handed straight back at runtime. Replaced by `privd`-owned secret files.
- **A separate Unix role for the human user.** Rejected: user/agent cannot be split by uid (app and agent
  share 1000); the split is an app-authentication boundary, with the app brokering user file ops as `privd`.
- **No privileged path at all** (confinement + `apt_install` only). Still the correct posture when
  _unconditional_ airtightness matters more than the trigger-privileged-work capability; the privileged path
  is additive and should be built only when a real workflow needs it.

Notes

- Related: [container-per-workspace-sandbox.md](../accepted/adr-container-per-workspace-sandbox.md),
  [docker-socket-proxy.md](../accepted/adr-docker-socket-proxy.md),
  [prd-workspace-secrets.md](../../prd/draft/prd-workspace-secrets.md).
- Prior implementation: branches `feat/agent-privilege-model` and `permission-model` (unmerged).
- "Confused deputy": a privileged actor tricked by a less-privileged party into misusing its authority on the
  attacker's behalf. Here: a keyed script (authority = `privd`) coerced — via agent-controlled args or
  agent-writable dependencies — into reading/writing locked files for the agent. The defense is the closure
  rule + fixed argv (no agent-controlled target), the capability-style fix.
