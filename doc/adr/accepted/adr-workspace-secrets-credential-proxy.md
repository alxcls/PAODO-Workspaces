Title: Workspace secrets via a MITM credential proxy

Status: Accepted

Context

Agents often need a third-party credential (API key, bearer token) to call an outside service.
Putting the real value in the container's environment fails the threat model: the agent runs
untrusted code and can read its own env, so it could print, log, or leak the secret. The container
is exactly the component we do not trust with plaintext. We need the agent to *use* a credential on
outbound calls without ever *holding* it. The platform already routes containers through
host-controlled infrastructure, so mediating egress fits the existing posture. Constraints: package
installs and clones (pypi, apt, github) must keep working; no new datastore (metadata is JSON on
host); shared runtime state must survive the Next.js route/custom-server module split (held on
`global`).

This is a leak-resistance measure, not a vault — see Consequences.

Decision

A transparent, per-workspace **credential proxy** swaps opaque tokens for real values on outbound
HTTPS. The container never receives a plaintext secret.

1. Tokens in the container, values encrypted on the host. Each secret (name, value, target domain)
   is stored in `data/.workspace-secrets.json`, AES-256-GCM encrypted at rest
   (`secretsEncryption.ts`) under a host-only 32-byte key (`data/.proxy-ca/secrets-enc.key`, `0600`,
   self-provisioned on first use; legacy plaintext migrates on load; corrupt file fails closed to an
   empty store). The container gets an opaque token per secret, `__pxy_<wsId>_<NAME>__`, as env var
   `<NAME>`. The API and system prompt only ever expose metadata, never the value.
   `workspaceSecretStore.ts`.

2. The proxy is the container's sole egress. Containers launch with `HTTP(S)_PROXY` pointing at
   `host.docker.internal:9998` (`CREDENTIAL_PROXY_PORT`). The proxy URL carries the workspace id as
   username and `HMAC(hostKey, wsId)` as password. `containerManager.ts`.

3. MITM only for configured domains; tunnel everything else. On CONNECT, if the target host exactly
   matches a configured secret's domain (subdomains excluded), the proxy terminates TLS with a
   cert it signs on the fly, substitutes tokens → real values in the request target, all header
   values (incl. base64 `Authorization: Basic`) and buffered bodies (≤10 MB), then re-originates TLS
   upstream with `rejectUnauthorized: true`. Every other host (pypi, apt, github) is a plain TCP
   tunnel — untouched. `credentialProxy.ts`.

4. Responses are redacted. On the MITM path, real values are substituted back to tokens in response
   headers and body (streaming, with a chunk-boundary carry so SSE is not stalled; `Accept-Encoding`
   stripped so bodies stay scannable). An upstream echoing the *literal* key back (API error
   messages) never exposes plaintext. Transformed echoes (base64, truncation) are not caught.

5. HTTPS-only injection. Plain HTTP forwards the opaque token untouched (substituting on cleartext
   would leak to an on-path observer); upstream rejects it — fail closed, not leak.

6. Per-workspace CA + auth. One CA is generated at startup, persisted to `data/.proxy-ca/`
   (`proxyCA.ts`); containers trust it via `NODE_EXTRA_CA_CERTS` (additive) plus a combined bundle
   for the replacement stores (`REQUESTS/CURL/SSL_CERT_*`) so TLS to tunneled hosts still verifies.
   A host-only HMAC key derives each workspace's proxy secret; the proxy injects only when the
   presented secret verifies (constant-time). Wrong/absent secret → empty rule set (fail closed),
   connection still tunnels.

7. SSRF guard on every relay. As every container's egress, the proxy is a confused-deputy risk. All
   relays pass `destinationGuard.ts`, which blocks non-globally-routable IPs (loopback, RFC1918,
   CGNAT, 169.254 metadata, IPv4-mapped IPv6, …). Hostnames use a guarded lookup that resolves and
   checks in one call, closing the DNS-rebinding gap. Fails closed on unparseable input.

8. Lifecycle. Rules live in the proxy's in-memory map, rehydrated from disk at startup. Adding/
   removing a secret updates store + rules. Containers carry a `paodo.workspace-secrets-hash` label;
   when the secret set changes, the container is recreated so its env reflects it. Deleting a
   workspace clears its secrets and rules.

Consequences

Enables
- Agents call third-party services with a credential they never possess; a careless or literal-echo
  leak exposes only the opaque token.
- Each secret is scoped to exactly one host; a key for one API is never injected elsewhere.
- No new datastore; encryption protects backups/snapshots.

Costs / risks
- The proxy is a MITM for configured domains: the CA key and encryption key on the host are now
  sensitive assets (`0600`).
- A single shared process on every container's egress (bounded 64 KB header / 10 MB body reads guard
  against OOM); `destinationGuard` is load-bearing platform-wide — treat changes as security-critical.
- Does NOT stop: an attacker with host access (keys live there); exfiltration via an upstream the
  agent deliberately steers, or a transformed echo of the secret; computed-secret auth (SigV4/HMAC
  signing, SCRAM) where no literal token rides the wire — those are unsupported and fail rather than
  leak.

Alternatives considered
- Real value in container env — defeats the threat model. Rejected.
- Sidecar/broker with a placeholder — needs a bespoke API; breaks transparent `curl`/`requests`.
  Rejected for `HTTP_PROXY` interception existing tooling already honors.
- External secrets manager (Vault) — heavier than a single-VPS deploy warrants; value still lands in
  the container at call time. Not precluded later.
- Host allowlist instead of IP-class SSRF guard — breaks installs spanning many hosts.
- Subdomain (wildcard) matching — a key must never leak to a sibling host. Exact host only.

Notes
- PRD: doc/prd/accepted/prd-workspace-third-party-api-keys.md (Shipped).
- Impl: lib/infra/proxy/{credentialProxy,proxyCA,destinationGuard,index}.ts,
  lib/infra/security/{workspaceSecretStore,secretsEncryption}.ts, containerManager.ts, server.ts.
- Related: adr-container-per-workspace-sandbox, adr-container-server-proxy,
  adr-metadata-storage-json-vs-db, adr-single-instance-in-process-state.
