# PRD — Agent restriction model (locks, privileged scripts, hidden files)

**Status:** Accepted
**Author:** @alxcls
**Related:** [VISION.md](../../VISION.md), [prd-workspace-secrets.md](../draft/prd-workspace-secrets.md)

---

## Problem

By default the agent can read and write every file in a workspace. That is fine for throwaway automation, but it blocks real-world use: hand-curated reference data gets overwritten, frozen scripts drift, and credentials or client data under NDA/GDPR can end up in the model's context. Users need simple, reliable control over what the agent can **change** and what it can **see** — without supervising every step.

## Goals

- Give users three independent, one-click controls over any file or folder: make it **read-only**, **mark a script as privileged** so the script has elevated right, or **hide its contents** from the agent.
- Guarantee the protections hold even when the agent writes and runs its own scripts — real enforcement, not advisory checks.
- Keep the agent aware of every file's state so it explains restrictions clearly instead of failing confusingly or trying to work around them.
- Let users run the agent autonomously, confident that protected files won't drift and confidential data won't leak.

## Non-goals

- Per-user or per-role permissions — one workspace has one owner and one permission state.
- Secret storage itself (see [Workspace Secrets](../draft/prd-workspace-secrets.md)) — this PRD covers *who may use* secrets, not how they are stored.
- Pausing or killing an agent run — a separate concern.

## The model

Every file and folder has three independent states, each toggled by its own icon in the file tree and shown to the agent as a tag in the order `[write] [privilege] [visibility]`:

| Control | Icon | Agent sees | Meaning |
|---------|------|------------|---------|
| Write | lock | `[RW]` / `[R]` | `[R]` = read-only: the agent can read and execute it but never change or delete it. |
| Privilege | key | `[U]` / `[P]` | `[P]` = privileged: the user has marked this script as trusted and auto-locked it so the agent cannot tamper with it. the script can call workspace environment variables and it can be used to modify other folders and files
| Visibility | eye | `[V]` / `[H]` | `[H]` = hidden: the agent sees the file's name but can never read its content. |

Rules of the model — all automatic and enforced:

- **Privilege → lock (one direction).** Granting privilege automatically locks the file (`[R]`). Revoking privilege is metadata-only — the lock stays in place; only an explicit unlock clears it.
- **Unlock → revokes privilege.** Setting a privileged file to `[RW]` automatically revokes its privilege first. The two states cannot diverge: `[RW]` + `[P]` is not a valid combination.
- **Visibility is fully independent.** Hiding or revealing a file does not touch the lock or privilege state. A file can be `[H]` + `[R]`, `[H]` + `[P]`, or any combination. When revealed, the on-disk state is restored from the current lock/privilege registry.
- A locked file (`[R]`) can still be executed by the agent; it just cannot be modified. Lock means write-protection, not execution prevention.
- **Only the user** can set any of these states. The agent has no way to grant itself privilege or lift a restriction.
- A whole workspace can also be put into a single hardened read-only mode.

## User stories

> As a citizen developer, I want to mark a folder read-only so the agent can analyse it but never overwrite or delete my source files.

> As a citizen developer, I want to mark a script as trusted so the agent cannot edit or replace it, while I know it runs exactly the script I approved.

> As a consultant under NDA, I want to hide a folder of client data so the agent can run scripts that process it but can never read its contents.

> As a citizen developer, I want the agent to tell me exactly what to unlock, grant privilege to, or reveal when it is blocked — instead of failing confusingly or inventing a workaround.

> As a service builder, I want to run the agent autonomously, confident that protected files will not drift and confidential data will never enter the model.

## Requirements

### Must have

- Three independent toggles (lock / key / eye) on any file or folder in the tree; applying one to a folder covers everything inside it.
- All three states are set **only** by the user in the UI — the agent has no tool or prompt path to change them.
- Privilege implies lock: granting privilege auto-locks; unlocking a privileged file auto-revokes privilege. Visibility is orthogonal to both.
- Protections cannot be bypassed by the agent writing and running its own scripts.
- `[R]` blocks writes and deletes (execute is permitted); `[H]` blocks all content reads for the agent and any script it runs (the file-read tool and shell commands such as `cat`/`grep` return nothing); `[P]` marks a script as trusted and auto-locks it — all three restrictions are kernel-enforced and apply equally to the agent and to scripts it executes.
- The agent sees all three tags on every file and, when blocked, names the file and the icon the user should click.
- All states survive server restarts.
- A workspace-wide read-only mode that also stops the agent installing packages or running write commands.
- The user can always view hidden content via the file-tree viewer.

