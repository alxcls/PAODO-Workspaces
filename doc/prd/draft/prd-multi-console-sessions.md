# PRD — Multi-Console Sessions

**Status:** Draft  
**Author:** OpenCode  
**Related:** [VISION.md](../../VISION.md), [prd-agent-toolset.md](../accepted/prd-agent-toolset.md)

---

## Problem

Today each workspace has one shared console. This becomes hard to follow when the user needs to keep a server running, inspect logs, and run one-off commands at the same time. Output gets mixed together, which makes it harder to understand what is happening and what can be safely stopped.

## Recommendation

This is a good idea if it is introduced as multiple **named console sessions** inside one workspace.

The value is clarity, not complexity: users should be able to separate ongoing work into simple contexts like `task`, `server`, and `logs` without changing the core product model.

## Goals

- Let a workspace have more than one console session.
- Let users clearly separate different kinds of work.
- Make it obvious which console is running which process.
- Let users stop one process without affecting unrelated work.
- Keep the default experience simple for users who only need one console.

## Non-goals

- Turning the workspace into a full terminal manager.
- Running multiple agent jobs in parallel inside the same workspace.
- Adding advanced layouts such as panes or splits in v1.

## User stories

- As a user, I want to keep my app running in one console while using another console for checks and fixes.
- As a user, I want a separate logs console so debugging output does not bury everything else.
- As a user, I want to know which console a process belongs to so I can understand the workspace at a glance.
- As a user, I want to stop one console's process without interrupting the rest of my workspace.

## Requirements

### Must have

- A workspace can contain multiple named console sessions.
- The user can create, rename, switch, and close console sessions.
- Each console keeps its own output history.
- Each console clearly shows whether it is active or idle.
- Commands run in a specific console rather than in one shared stream.
- The product always provides a default console for users who do not create additional sessions.

### Nice to have

- Suggested default console names such as `task`, `server`, and `logs`.
- Ability to pin a preferred default console.
- Simple status indicators for running or errored consoles.

## Success criteria

- Users can keep long-running work separate from one-off commands.
- Users can understand console output faster and with less confusion.
- Users can manage running processes more confidently.
- Users who only use one console see no added complexity.
