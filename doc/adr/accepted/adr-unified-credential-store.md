# ADR — Unified credential store

Title: One store and one lifecycle for every minted bearer key

Status: Accepted

## Context

PAODO issues three minted bearer keys, one per programmatic access channel:

| Channel        | Prefix | Scope             |
| -------------- | ------ | ----------------- |
| HTTP agent API | `sk_`  | one per workspace |
| Workspace MCP  | `mcp_` | one per workspace |
| CLI / platform | `cli_` | one per instance  |

Each had its own module — `apiKeyStore.ts`, `mcpConfigStore.ts`, `platformTokenStore.ts` — written by
copy-paste. `mcpConfigStore.ts` said so in its own header ("Mirrors the apiKeyStore/scheduleStore
idiom"). The same logic therefore existed three times at three layers: store, route, and UI
component.

This was primarily a maintenance problem, but the triplication had also produced real defects rather
than mere naming drift:

- **The platform token could not be revoked at all** — only disabled, leaving the hash on disk. The
  CLI PRD requires that revoking a key immediately prevents further access.
- **`apiKeyStore` leaked a hash into its route.** `api-key/route.ts` called `generateKey()` and passed
  the resulting hash back into `setKey()`; the other two never let a hash cross that boundary.
- **All three `getState()` returned the hash**, leaving each route to hand-write `hash !== null`.
  Three independent opportunities to serialize a hash into a JSON response.
- **Three names per operation** (`setEnabled` / `setEnabled` / `setPlatformAccessEnabled`;
  `revokeKey` / `revokeSecret` / _missing_) and two field names for one concept (`keyHash` /
  `secretHash`).

Deployment was greenfield — the data directory is wiped — so no migration path was required.

## Decision

One module, `lib/infra/security/credentialStore.ts`, owns every minted bearer key.

**One record per `(kind, subject)`.** `kind` is `"workspace-api" | "workspace-mcp" | "platform"`;
`subject` is a workspace id, or `null` for the instance-wide platform credential. Records are keyed
naturally (`workspace-api:ws-1`, `workspace-mcp:ws-1`, `platform`), so there are no synthetic token
ids and no lookup indirection. Cardinality is exactly one, matching the product: one API key per
workspace, one MCP key per workspace, one CLI token for the instance.

**One lifecycle, used by all three channels:**

```
mint(kind, subject?): string                 // generate + store; plaintext returned once
revoke(kind, subject?): void                 // destroy the hash, keep the record
setEnabled(kind, subject?, enabled): void    // open or close the channel
state(kind, subject?): CredentialState       // public fields only — cannot carry a hash
validate(kind, subject, plain): boolean      // fails closed; refreshes lastUsedAt
remove(kind, subject?): void                 // forget entirely (cleanup, not revocation)
removeWorkspace(subject): void               // both workspace kinds, for workspace deletion
```

**Storage: JSON + `globalSingleton`** at `WORKSPACES_ROOT/.credentials.json`, matching the eleven
other configuration stores. SQLite (`.paodo.db`) stays reserved for high-volume append data
(`conversations`, `sessions`, `turns`).

**Prefixes are derived from `kind`** by one internal table rather than hardcoded at three mint sites.
They are retained deliberately: a leaked key stays identifiable in a log or a secret scanner.

**`mint` is one step and hashes never leave the module.** No `generateKey`-style export exists, so a
route cannot handle a hash.

**`validate` returns a boolean, not a record.** At cardinality one the identity _is_ `(kind, subject)`
and every call site already knows both, so a record would add nothing.

**One `enabled` flag, owned by the credential**, meaning "this access channel is on". A disabled
channel rejects every key. `mcpConfigStore` is therefore absorbed whole: the split briefly left a
`mcpSkillStore.ts` behind it for the published skill selection, and dropping per-skill publication
(see [Workspace MCP gateway over declared skills](adr-workspace-mcp-skill-gateway.md))
removed that too, so `enabled` plus the key is all the MCP endpoint stores.

**`lastUsedAt` is throttled to one write per 60s per credential**, since every save rewrites the whole
file. Its persistence is best-effort: a disk failure logs a warning rather than failing a valid
authentication.

**Authorization is the route allowlist in `platformAccessPolicy.ts`, not a property of the
credential.** The one platform key either matches or it does not; there are no per-key scopes.

**Authentication failure and authorization denial are now distinguished in `checkAuth`.** A bad key
feeds the brute-force tracker; a valid key on a route with no mapped permission does not. The
tracker is shared with the UI's Basic auth, so counting the latter would let a misconfigured script
polling an unshared route lock its own operator out of the web interface after five requests.

### Vocabulary

**The product noun is "key", everywhere a caller or an operator can see it.** `hasKey` on the wire,
`workspaceApiHasKey` / `workspaceMcpHasKey` on the workspace read, "Generate key" / "Key active" /
"Key required" in the UI. The CLI token is a key too; only its `cli_` prefix and its instance-wide
scope make it different.

**"Secret" survives as the security property, not as a name for the thing.** A key may be public; a
secret may not. `credentialStore.ts` is where that property is enforced — `hashSecret()`, and the
statement that keys are stored only as SHA-256 hashes — so it is the one place the word is still
correct. Nothing outside that module needs it.

**Which is what makes the third-party store's name meaningful.** `workspaceSecretStore` holds
`ThirdPartySecret` values, reversibly encrypted because the proxy must recover them, and `secret` is
a field PATCH accepts on a workspace. Those are genuinely secrets and keep the word. Had the minted
credentials also been called secrets, one workspace resource would have carried two unrelated
meanings of it — `workspaceApiHasSecret` next to `secret: ThirdPartySecret` — which is the collision
this split exists to prevent, and the reason `hasKey` is not `hasSecret`.

Two words for one concept at the same layer is the defect; the same word at two layers, meaning two
different things, is worse. Before this, `CredentialPanel` took a `noun` prop, so the API channel said
"key" and the MCP channel said "secret" for identical machinery — on a page that also shows
third-party secrets. The prop is gone: the panel says "key" in plain strings.

The other layers keep their own verbs deliberately, and this is not drift: the store mints and
revokes, the wire's POST body carries `operation: "generate" | "rotate"`, and the audit stream records
`credential_minted` / `credential_revoked` / `credential_enabled_changed`. Each names what its own
layer does.

The route and UI layers were deduplicated to match:

- `lib/api/credentialRoutes.ts` — `credentialHandlers(kind, resolveSubject)` supplies POST / DELETE /
  PATCH for all three management endpoints, plus a shared `publicBaseUrl()`. GET stays per-route
  because each returns different extras, but every GET spreads `state()` so the wire shape is
  identical. The wire field is `hasKey` everywhere.
- `lib/client/hooks/useCredential.ts` — the load / toggle / mint / reveal-once / revoke cycle.
- `components/shared/CredentialPanel.tsx` and `CredentialReveal.tsx` — the card chrome and the
  reveal-once key box.

`/api/settings/cli-access` remains absent from `platformAccessPolicy.ts`, so the CLI token can never
reach the route that mints or rotates it.

## Consequences

Enables:

- **Revocation for the CLI token**, which did not exist before (`DELETE /api/settings/cli-access`).
- **One place to add per-credential features** — expiry, naming, richer last-used reporting — instead
  of three.
- **One audit vocabulary**: `credential_minted` / `credential_revoked` / `credential_enabled_changed`,
  each tagged with `kind`, replacing six parallel event names.
- **A fourth access channel becomes cheap**: add a `kind`, mount the handlers, drop in the panel.
- **One crypto path.** SHA-256 and `timingSafeEqual` now have to be right once rather than three
  times. A length guard was added so a hand-edited or truncated store denies instead of throwing.

Costs and risks:

- Enabling a channel and creating its key are always two steps, on every channel and every trigger.
  Neither operation moves the other's state: `mint` leaves the enabled flag as it found it, `setEnabled`
  never creates or destroys a key, and `revoke` ignores the enabled flag entirely — though it does
  require a key to destroy, refusing with `CREDENTIAL_NOT_CONFIGURED` when the slot is already
  empty, so a successful revocation always means a live key stopped working. The cost is a second step in the
  UI; the gain is that a key can be issued before a channel opens and destroyed after it closes, and
  that no caller is handed a read-once plaintext by a request it made for another reason.
- Because a shared module is now on every programmatic auth path, a regression here fails all three
  channels at once. Mitigated by running the full fail-closed matrix per kind in
  `credentialStore.test.ts`.
- `lastUsedAt` is coarse (60s) by design, and is unsuitable as an audit timestamp.

## Alternatives considered

**A SQLite `tokens` table.** Would give exact `lastUsedAt` via a cheap single-row UPDATE and real
rows. Rejected: it introduces a second storage paradigm for configuration data, diverges from the
eleven existing JSON stores, pulls `lib/data` into the edge auth path, and requires `sqlite3` to
inspect on the VPS. Coarse last-used is an acceptable price for a file that can be read with `cat`.

**One shared key across all three channels.** Rejected: the channels have different blast radii
(the agent and MCP endpoints are published on a DNS-direct public host per
`deploy/caddy/Caddyfile`, while the CLI token is instance-wide), different owners and rotation
lifecycles, and different payloads. Merging them would either widen a third-party integration key to
instance scope or reintroduce a scoping table, which merges nothing.

**Many credentials per subject.** Would enable zero-downtime rotation by minting before revoking.
Rejected: the product has exactly one key per channel, and rows-with-ids would add a synthetic id and
a lookup layer for a benefit nothing currently needs.

**Splitting `enabled` into a credential flag and a feature flag.** Rejected: at cardinality one this
is two flags where one suffices, and a second check a route could forget to make is a fail-open risk.

**Folding in `workspaceSecretStore` / `secretsEncryption`.** Rejected: those hold reversibly encrypted
values the credential proxy must recover, a fundamentally different primitive from one-way-hashed
bearer keys — and the reason the two keep different names (see Vocabulary).

**Folding in the UI's Basic auth / session cookie (`wsSession.ts`).** Rejected: that is a human login,
not a minted key.

## Notes

- Related: `doc/prd/accepted/prd-cli-access.md`, `doc/trigger-operation-architecture.md`
- Deliberately out of scope: **actor attribution** ("which credential started this run?").
  `sessions.origin` (`lib/data/migrations/001-baseline.ts`) already constrains to
  `('chat','api','mcp','scheduled','agent','manual')`, so that work is adding `'cli'` and threading
  `origin` through run creation — not inventing a vocabulary. `CredentialKind` names were chosen to sit
  alongside it.
- Also out of scope: where validation happens. The platform credential is still validated at the edge
  in `server.ts`; workspace credentials are still validated in-route. Both are correct — the edge can
  gate any route generically, and a route already knows its own workspace id.
