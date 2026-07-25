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
   when off, so the model has no way to invoke them — not merely an instruction not to.
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
- Several call sites fall back to `internetAccess ?? true` when a workspace record is entirely
  missing (as opposed to present-but-defaulted), which is fail-open relative to the "new workspaces
  default off" posture. Low practical exposure (a running agent's workspace record should always
  exist) but worth tightening to fail-closed.
- One more moving part on toggle: three writes (store, policy file, container stop) must all
  succeed for the flag to fully take effect; a partial failure is logged loudly (`setInternetAccessPolicy`
  throws on a failed persist) rather than silently leaving a workspace in a mixed state.

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
