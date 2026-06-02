# PRD — Agent Privilege Model

**Status:** Accepted
**Author:** @alxcls
**Related:** [VISION.md](../../VISION.md), [prd-workspace-secrets.md](../draft/prd-workspace-secrets.md)

---

## Problem

By default the agent can read and write every file in a workspace. That is fine for throwaway automation, but it blocks real-world use: hand-curated reference data gets overwritten, frozen scripts drift, and credentials or client data under NDA/GDPR can end up in the model's context. Users need simple, reliable control over what the agent can **change** and what it can **see** — without supervising every step.

## Goals

- Give users three independent, one-click controls over any file or folder: make it **read-only**, **authorize a script** to run with elevated rights, or **hide its contents** from the agent.
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
| Write | lock | `[RW]` / `[R]` | `[R]` = read-only: the agent can read it but never change or delete it. |
| Privilege | key | `[US]` / `[S]` | `[S]` = privileged script: a script the user trusts to run with elevated rights (and with workspace secrets). It is the only actor allowed to change protected files. |
| Visibility | eye | `[V]` / `[H]` | `[H]` = hidden: the agent sees the file's name but can never read its content. |

Rules of the model — all automatic and enforced:

- Granting privilege or hiding a file **automatically locks it** (`[R]`); revoking privilege or revealing it **automatically returns it to writable** (`[RW]`). The user never has to set the lock separately.
- While a file is privileged or hidden, its lock **cannot be changed on its own** — the key/eye owns the write state, and a direct lock/unlock on it is refused.
- A plain locked file (just `[R]`) carries no privileged or hidden status; unlocking it simply makes it writable again.
- Privileged and hidden are mutually exclusive — a file is one or the other, never both.
- **Only the user** can set any of these states. The agent has no way to grant itself a privilege or lift a restriction.
- A whole workspace can also be put into a single hardened read-only mode.

## User stories

> As a citizen developer, I want to mark a folder read-only so the agent can analyse it but never overwrite or delete my source files.

> As a citizen developer, I want to authorise one specific script to update a locked file, while the agent still cannot touch that file directly or through scripts it writes.

> As a consultant under NDA, I want to hide a folder of client data so the agent can run scripts that process it but can never read its contents.

> As a citizen developer, I want the agent to tell me exactly what to unlock, grant privilege to, or reveal when it is blocked — instead of failing confusingly or inventing a workaround.

> As a service builder, I want to run the agent autonomously, confident that protected files will not drift and confidential data will never enter the model.

## Requirements

### Must have

- Three independent toggles (lock / key / eye) on any file or folder in the tree; applying one to a folder covers everything inside it.
- All three states are set **only** by the user in the UI — the agent has no tool or prompt path to change them.
- The lock follows the key and eye automatically: granting privilege/hiding locks the file, revoking privilege/revealing unlocks it, and the lock cannot be toggled independently while a file is privileged or hidden.
- Protections cannot be bypassed by the agent writing and running its own scripts.
- `[R]` blocks writes and deletes; `[H]` blocks all content reads (the file-read tool and shell commands such as `cat`/`grep` return nothing); `[S]` privileged scripts are the only actor that may write protected paths and the only way secrets are used.
- The agent sees all three tags on every file and, when blocked, names the file and the icon the user should click.
- All states survive server restarts.
- A workspace-wide read-only mode that also stops the agent installing packages or running write commands.
- The user can always view hidden content, and privileged scripts can always use it.

### Nice to have

- Persistent badges in the file tree (not only on hover) with explanatory tooltips.
- A notice in the agent chat when a read was blocked: _"Contents not seen by agent."_
- When blocked, the agent names the script it would grant privilege to or the file it would unlock and asks the user to confirm.
