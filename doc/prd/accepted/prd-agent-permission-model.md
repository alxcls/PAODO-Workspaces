# PRD — Agent permission model (hidden / locked / privileged files)

**Status:** Accepted
**Author:** @alxcls
**Related:** [VISION.md](../../VISION.md), [ADR](../../adr/accepted/adr-agent-permission-model.md)

---

## Problem

By default the agent can read and write every file in a workspace. That blocks real-world use:
hand-curated reference data gets overwritten, frozen scripts drift, and credentials or client data under
NDA/GDPR can leak into the model's context. Users need simple, reliable control over what the agent can
**change** and what it can **see** — guarantees that hold even when the agent writes and runs its own
script, not advisory checks.

## Goals

- Three independent, one-click controls on any file or folder: **hide** its content from the agent,
  make it **read-only** to the agent, or mark a script **privileged**.
- The user (via the UI) can always see and modify everything, regardless of these states.
- Protections are kernel-enforced and apply equally to the agent's tools and to any shell command or
  script it runs.
- The agent is aware of every protected path, so it explains a restriction instead of failing
  confusingly or inventing a workaround.

## Non-goals

- Per-user or per-role permissions — one workspace, one owner.
- Workspace secret storage/injection (separate concern).
- A workspace-wide global read-only mode (possible follow-up).

## The model

| Control | Icon | Agent sees | Meaning |
|---------|------|------------|---------|
| Hide | eye | `[H]` | The agent cannot read the content; the name may still appear in listings. |
| Lock | lock | `[R]` | The agent can read/run it but cannot modify or delete it — even via a script it writes. |
| Privilege | key | `[P]` | A trusted script the agent may only run via `run_privileged_script`. It runs with rights to read `[H]` files and write `[R]` files. The agent cannot edit it. |

Rules (all automatic, enforced):

- **Privilege ⇒ lock.** Granting privilege auto-locks the script. Revoking privilege keeps the lock;
  only an explicit unlock clears it. **Unlocking revokes privilege** (`[RW]` + `[P]` is invalid).
- **Hidden is independent** of lock/privilege; any combination is allowed.
- Only the **user** sets these states (file-tree icons). The agent has no tool or prompt path to grant
  itself privilege or lift a restriction.

## User stories

> As a citizen developer, I want to mark a folder read-only so the agent can analyse it but never
> overwrite or delete my source files.

> As a citizen developer, I want to mark a script trusted so the agent runs exactly the script I
> approved and cannot edit or replace it.

> As a consultant under NDA, I want to hide a folder of client data so a trusted privileged script can
> process it but the agent can never read its contents.

> As a service builder, I want to run the agent autonomously, confident protected files won't drift and
> confidential data won't enter the model.

## Requirements

### Must have

- Three independent toggles (eye / lock / key) on any file or folder; applying one to a folder covers
  everything inside it.
- All three states set **only** by the user in the UI — no agent path changes them.
- Privilege implies lock; unlocking revokes privilege; visibility is orthogonal.
- Protections cannot be bypassed by the agent writing and running its own script (kernel-enforced).
- `[R]` blocks writes/deletes (read/execute permitted); `[H]` blocks all content reads for the agent and
  its scripts; `[P]` marks a trusted script the agent runs only via `run_privileged_script`, executed as
  a non-root identity that can read `[H]` and write `[R]` files.
- The agent sees every protected path and, when blocked, names the file and the icon to click.
- All states survive server restarts.
- The user can always view and modify hidden/locked content through the file-tree viewer.

## Verification

- Unit: store coupling invariants; reconcile builds the correct chown/chmod ownership per state; the
  privileged-script tool rejects non-privileged paths and execs as `privd`; `execute_command` rejects sudo.
- Integration (Docker): in a real container the agent cannot write a locked file, read a hidden file, or
  delete a locked file even via its own script; `privd` can; the app reads/writes both via root fallback.
