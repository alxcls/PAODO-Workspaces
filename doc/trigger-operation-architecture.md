# Triggers and operations

PAODO has several ways to initiate the same behavior:

```text
UI ───────────┐
CLI ──────────┤
HTTP agent API├──▶ shared operation ──▶ stores, runs, containers and files
MCP ──────────┤
Schedules ────┤
Agent network ┘
```

The trigger is not the action. A route, CLI command, MCP handler or scheduler is an adapter: it
authenticates its caller, translates input, invokes one operation, and formats the result. Business
rules belong in `lib/operations/` and must not be copied between adapters.

## Route sharing

The UI and CLI use the same REST route whenever they need the same contract. For example, both list
workspaces through `GET /api/workspaces`. There is no parallel `/api/cli/workspaces` tree.

Protocol-specific routes stay separate where their transport or caller contract is genuinely
different:

- The workspace agent endpoint uses a workspace-scoped key and streams agent events.
- MCP speaks the MCP protocol and uses a workspace-scoped MCP secret.
- The settings endpoint that creates the platform token is available only to the UI administrator.

Those adapters should still delegate to the same underlying run, skill, file or workspace operation.

## Read and mutation results

Query operations own resource representations. For workspaces, `GET /api/workspaces/<id>` is the one
authoritative overview assembled from workspace metadata, access state, exposed skills and secret
metadata.

Mutation operations return receipts: the target id, the capability fields successfully applied, and
the canonical values established for those fields. The values are assembled by
the operation after shared validation; an adapter must not echo its request as if it were the result.
Receipt field names use the public vocabulary shared by mutation requests and query representations.
An internal atomic grouping such as `model` is projected back to `llmProvider`, `llmModel` and, when
supported, `reasoningEffort`. Every name in `applied` has the same-named canonical value in `values`.
They are mutation outcomes, not partial resource snapshots: an adapter that needs fields outside the
write still performs the ordinary query. This keeps every trigger reading the same complete
representation and prevents mutations from silently adding work or sensitive metadata.

A receipt never carries a read-once secret. An operation that would produce one belongs on its own
explicit route, so the plaintext only ever reaches a caller that asked for it by name — a caller
updating unrelated settings cannot be handed a credential it will never see again by discarding a
field it had no reason to read.

## Programmatic access

`lib/infra/security/platformAccessPolicy.ts` is the single review point for exposing an existing
route to the platform token. Access is denied unless the exact HTTP method and route have an entry
there. Adding a UI route therefore does not silently add a CLI capability.

There is one instance-wide CLI key, stored only as a hash. It can call every route listed in the
policy; there are no per-key scopes. Creating, rotating, revoking, enabling and disabling that key
remain UI-administrator-only and are deliberately absent from the policy.

## Adding a capability

1. Find the existing operation. If logic lives in a route or component, extract it into
   `lib/operations/`.
2. Reuse the existing route when the UI and CLI contract is the same.
3. Add the route and HTTP method to the platform access policy.
4. Add the CLI command as a thin client of that route.
5. Test the operation once, then test each adapter's authentication and translation.
