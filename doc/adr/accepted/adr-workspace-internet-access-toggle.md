Title: Per-workspace internet access on/off toggle

Status: Accepted

Context
Some workspaces should never be able to reach the internet, so that no amount of prompt injection
or agent misbehavior can turn them into an exfiltration or fetch vector. Gating this at the prompt
or tool-description level alone would not be a real boundary — the guarantee has to hold even if the
model is fully compromised. The platform already isolates each workspace on its own Docker network
and mediates all secret-bearing egress through a per-workspace credential proxy (see
[adr-container-per-workspace-sandbox.md](adr-container-per-workspace-sandbox.md) and
[adr-workspace-secrets-credential-proxy.md](adr-workspace-secrets-credential-proxy.md)); this
decision adds an on/off switch to that existing egress path rather than building a new one.

Decision
Enforce "off" at the network layer first, and treat every other layer as defense-in-depth on top of
that, never as the sole control:

1. **Network layer (primary boundary).** `containerManager.ensureNetwork` creates the workspace's
   bridge network with `--internal` when off. Docker cannot flip `--internal` on a live network, so
   a mismatch (e.g. a network that survived an unclean exit under the old policy) is detected by
   inspecting the network and is force-disconnected and recreated with the correct flag before the
   container starts.
2. **Sidecar never attached.** The credential-proxy sidecar — the only thing on any workspace
   network that could bridge to the real internet — is attached only when `internetAccess` is true
   (`ProxyNetworkManager.attach`), and excluded by the boot-time reattach sweep
   (`reattachAll(shouldAttach)`) for off workspaces, so a redeploy can never hand one a route back
   out.
3. **Proxy-side policy check (defense-in-depth).** `internetAccessPolicy.ts` persists the flag to a
   JSON file the proxy sidecar polls (it runs as a separate process in production, no shared
   memory with the app). `credentialProxy.ts` checks it on every connection, after verifying the
   caller's HMAC-signed proxy identity — closing the case where layers 1–2 are ever misconfigured.
   This is explicitly not the primary guarantee: an off workspace's network has no path to the
   sidecar at all under normal operation.
4. **Tool binding.** `buildTools.ts` omits `http_get` and `apt_install` from the bound tool list
   when off, so the model has no way to invoke them — not merely an instruction not to. For
   `http_get` this is the _second_ gate, not the only one: its fetch runs inside the workspace
   container (`curl` via `ExecRunner`, `webFetch.ts`), so an off workspace's `--internal` network
   blocks it at layer 1 exactly like `apt_install`. It previously ran in the app process and so had
   tool-binding as its sole gate — the one tool in the system without a network-layer backstop.
5. **Prompt.** `promptContext.ts` states the current status in plain language so the agent doesn't
   burn turns retrying shell commands that cannot succeed.

Persistence: `WorkspaceMetadata.internetAccess` (boolean, default `false` for newly created
workspaces; hydrates to `true` for pre-existing registry records so upgrades don't silently break).
The `PATCH /api/workspaces/[id]/internet-access` route writes the store field, writes the proxy
policy file, and stops the running container — so the network is guaranteed rebuilt with the
correct flag before the agent runs again, with no window where stale state lingers.

Consequences

- The guarantee holds even against a fully compromised model: there is no tool call or shell
  command that can produce a real socket to the internet from an off workspace, because none of the
  three independent layers (network, sidecar attachment, tool binding) can be talked around from
  inside the container.
- Toggling off mid-session stops the container; the agent's next turn starts a fresh one on the
  correct network. No live "downgrade" of a running container's networking.
- Does not cover non-internet content channels: connected drives (host-side shared directories) and
  inter-workspace `call_agent` traffic are untouched by this flag by design — they are separate,
  explicitly-opted-into channels, not "internet." An off workspace can still be handed
  attacker-influenced text via those paths; it simply cannot act on it by reaching out further.
- Every call site that reads `internetAccess` (`containerManager.ts`, `buildTools.ts`,
  `promptContext.ts`) fails closed — `false` — when a workspace record is entirely missing, not just
  present-but-defaulted. Only a record that predates this field defaults to `true` via `hydrate()`.
- The proxy's policy file (`internetAccessPolicy.ts`) is synced at workspace creation, not only on
  toggle: `workspaceStore.createWorkspace()` calls `setInternetAccessPolicy(id, false)` right after
  persisting the new (internet-off-by-default) record, so the defense-in-depth layer can't disagree
  with the primary (network) layer from the moment a workspace exists — before this, a sparse
  policy file (absent key = enabled) read as "on" for any workspace never yet explicitly toggled.
- The toggle route's three writes (store, policy file, container stop) are not fully atomic, but
  failures are handled asymmetrically by design: a policy-file write failure rolls the store field
  back to its previous value (the two must never disagree — one is the primary boundary's source of
  truth, the other its defense-in-depth check), while a container-stop failure does _not_ roll back
  an already-consistent store/policy — reverting a user's explicit toggle because Docker hiccuped
  would be worse than a delayed cutover, and it self-heals: the secrets hash `ensure()` checks on
  every wake folds in `internetAccess`, so the next wake forces a correct recreate regardless of
  whether the explicit `stop()` succeeded.
- `ContainerManager.ensure()` and `.stop()` are mutually exclusive per workspace (a shared,
  kind-tagged lock keyed by workspace id): a `stop()` from the toggle route can't interleave with a
  concurrent agent tool call's `ensure()` reattaching the sidecar (or vice versa) mid-transition.
  Concurrent `ensure()` calls still coalesce onto one shared promise as before; a concurrent
  `ensure()` racing a `stop()` instead waits for the `stop()` to finish and then runs its own fresh
  pass, since piggybacking on a `stop()`'s promise would incorrectly report "ready" for a container
  that was just torn down.

- Moving `http_get` in-container (point 4) also retired `lib/agent/ssrfGuard.ts`, whose sole consumer
  it was. That guard existed to contain a _host-side_ fetch: in the app's network namespace
  `127.0.0.1` is the platform server, `socket-proxy:2375` is a Docker API grant, and
  `169.254.169.254` is host IAM credentials, so an agent-supplied URL there was a privilege
  escalation held back by string parsing. In-container the network namespace enforces that
  structurally, and the reachability is what `execute_command`'s shell already has. The tool's
  traffic now transits the credential proxy, so `destinationGuard.ts` applies the equivalent SSRF
  checks with audit logging at the egress chokepoint for all container traffic. `webFetch.ts` must
  therefore never pass `--noproxy`: `HTTP_PROXY` is env-var convention, not iptables, and opting out
  of the proxy would opt out of that guard. The DNS-rebinding pin (resolve app-side, connect to the
  approved IP) is not reproducible once curl resolves in-container; the proxy's `makeGuardedLookup`
  covers proxied traffic instead. Two limits of "all traffic transits the proxy" are worth stating
  plainly: `no_proxy` exempts the container's own loopback (so a workspace can reach its own dev
  server), which is unguarded but is exactly what `execute_command` already reaches — and matches on
  the host string, so a hostname resolving to `127.0.0.1` is still proxied and still guarded; and
  `--proto-redir "=https"` is what stops `-L` from following a redirect off TLS, since the app-side
  per-hop `Location` re-validation disappeared with the guard.
- Consequently `http_get` is now on the credential path: a fetch to a domain with a configured secret
  rule gets the real value substituted in. Scoped by existing proxy design — exact-host match only
  (no subdomains), HTTPS only, responses redacted real→token — so a fetch at an attacker-named host
  matches no rule and injects nothing. This is a capability gain (authenticated fetches) that
  `execute_command` + `curl` already had.

Alternatives considered

- Filter/allowlist egress instead of removing the network: rejected — still requires trusting a
  filter to catch everything a compromised agent might try, and the whole point of "off" is to not
  need that trust.
- Gate only at the tool-binding layer (hide `http_get`/`apt_install`): rejected as insufficient on
  its own — `execute_command` gives the agent a full shell, so anything not blocked at the network
  layer is reachable via `curl`/`wget` regardless of which tools are bound.
- Gate only in the credential proxy (app-layer check, sidecar stays attached): rejected as the sole
  control — a workspace network that's merely policy-blocked but network-reachable to the sidecar is
  one proxy bug away from leaking.

Notes
See [prd-workspace-internet-access-toggle.md](../prd/accepted/prd-workspace-internet-access-toggle.md) for the product framing.
