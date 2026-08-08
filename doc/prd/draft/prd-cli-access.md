# PRD — CLI Access

**Status:** Draft  
**Author:** alxcls  
**Related:** [VISION.md](../../VISION.md)

---

## Problem

PAODO can mainly be managed through its web interface. This works well for a
person, but it makes repeated tasks, automation, and use by coding assistants
such as Claude Code or Codex difficult.

Users need a safe way to operate PAODO from a terminal so that both people and
coding assistants can work with workspaces without clicking through the
interface.

## Goals

- Make the main PAODO actions available from a command-line interface.
- Let Claude Code, Codex, scripts, and automation tools use PAODO reliably.
- Keep actions performed through the CLI visible in the web interface.
- Protect CLI access with a key that can be disabled or revoked.
- Provide clear results that are easy for both people and software to
  understand.

## Non-goals

- Replacing the web interface.
- Reproducing visual-only actions such as opening panels or changing the page
  layout.
- Supporting multiple CLI keys or per-key permission scopes.
- Replacing workspace API or MCP access.

## User stories

> As a PAODO user, I want to manage my workspaces from a terminal so that I can
> automate repeated work.

> As a Claude Code or Codex user, I want my coding assistant to start work in a
> PAODO workspace and collect the result.

> As an operator, I want to see CLI activity in the PAODO interface so that I
> can understand, stop, or review what happened.

> As an administrator, I want to revoke CLI access immediately if a key is lost
> or misused.

## Requirements

### Must have

- The CLI covers the main actions available to users in PAODO.
- It can start, follow, and stop agent work.
- It can inspect and manage workspaces and their content.
- It uses a dedicated access key that is shown once and stored securely.
- The single key can access every action explicitly exposed to the CLI.
- CLI access can be disabled, rotated, and revoked through the web interface.
- The CLI key cannot create, rotate, revoke, enable, or disable itself.
- Every action returns a clear success or failure result.
- Activity started through the CLI appears in the same history and monitoring
  views as activity started through the web interface.
- The CLI and web interface follow the same rules and produce the same outcome.

### Nice to have

- Save and reuse connection profiles for different PAODO servers.
- Export and reapply a PAODO setup.
- Create temporary workers from approved workspace templates.
- Set limits on how many agents an external assistant can start and how much
  they can use.

## Success criteria

- A user can perform the main PAODO workflows without opening the browser.
- Claude Code or Codex can start work, follow its progress, and retrieve its
  result without special integration code.
- A user can review and control that activity from the PAODO web interface.
- Revoking a CLI key immediately prevents further access.
