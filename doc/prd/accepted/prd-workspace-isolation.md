# PRD — Workspace Isolation

**Status:** Accepted
**Author:** @alxcls
**Related:** [VISION.md](../VISION.md), [prd-agent-network.md](prd-agent-network.md), [prd-agent-privilege-model.md](prd-agent-privilege-model.md)

---

## Problem

Each workspace is meant to be an independent service with its own goal, its own files, and potentially its own programming language or runtime. Without strict boundaries, two problems emerge:

**Agents leaking across workspaces.** If isolation is incomplete, an agent working in workspace A could inadvertently read, overwrite, or pollute something that belongs to workspace B — shared package directories, shared temp folders, or any file path that isn't properly scoped. Because agents run autonomously and issue shell commands, even an accidental path traversal can silently corrupt another workspace's state.

**Environment pollution between workspaces.** When a workspace installs a package (`npm install`, `pip install`, etc.), those packages must not end up visible to other workspaces. If they do, workspaces start depending on each other's side-effects — workspace B works because workspace A happened to install `pandas` first. That's invisible coupling that breaks without warning the moment workspace A is deleted or rebuilt.

---

## Goals

- An agent can only ever read or write files that belong to its own workspace
- Packages installed in one workspace are completely invisible to every other workspace
- Isolation is enforced at the infrastructure level — it does not depend on the agent following instructions

---

## Non-goals

- Sharing packages or a dependency cache across workspaces for performance — each workspace is fully independent
- Cross-workspace file access — if an agent needs data from another workspace, it must go through the agent network (see [prd-agent-network.md](prd-agent-network.md)), not the file system directly
- Preventing an agent from installing packages it needs — the goal is isolation, not restriction

---

## User stories

> As a citizen developer, I want to know that my "invoice-parser" workspace cannot accidentally read or overwrite files from my "customer-data" workspace, even if the agent makes a mistake.

> As a citizen developer, I want the agent to install any library it needs without worrying that it will break something in my other workspaces.

> As a citizen developer, I want to delete a workspace and know that every trace of its environment — packages, processes, temp files — disappears with it and doesn't affect anything else.

---

## How it works today

### File isolation

Each workspace gets its own directory on the host machine (`/data/<workspace-name>/`). The agent can only read and write inside that directory. Every file operation resolves the real path before acting — if the agent tries a path like `../../other-workspace/secret.json`, the system detects that the resolved path falls outside the workspace boundary and blocks it.

### Environment isolation

Each workspace runs inside its own Docker container. A new container is created the first time the workspace needs to run a command, and it is destroyed when the workspace is deleted. Because each container is a fresh, independent instance:

- `npm install` or `pip install` inside workspace A writes into workspace A's container only — workspace B's container never sees those packages
- The workspace directory on the host is the only thing shared between the host and the container. Nothing else crosses the boundary.

The container is stopped automatically after 10 minutes of inactivity and restarted transparently on the next command — so there is no cost to having many workspaces, only the ones actively in use consume resources.

### Network isolation

Each container is placed on its own private network. Containers cannot reach each other directly — there is no way for workspace A's agent to make a network call to workspace B's container. Cross-workspace communication can only happen through the explicit agent-to-agent call tool, which is graph-controlled and goes through the platform server (see [prd-agent-network.md](prd-agent-network.md)).

---

## Requirements

### Must have

- An agent's file operations are confined to its workspace directory. Any path that resolves outside that boundary is rejected with a clear error before anything is read or written.
- Packages installed by the agent (npm, pip, apt, etc.) are installed inside the workspace container. They are invisible to every other workspace.
- Deleting a workspace destroys its container and removes all installed packages — nothing is left behind that could affect other workspaces.
- Containers cannot communicate with each other at the network level. Cross-workspace interactions are only possible through the agent network tool.
- The workspace's runtime environment (language versions, installed runtimes) is set at the workspace level and does not depend on what other workspaces have installed.

### Nice to have

- The user can declare a list of dependencies to pre-install when the workspace is first created (e.g. a `requirements.txt` or a `package.json`), so the agent does not need to waste time installing them on its first run.
- The workspace settings panel shows the currently active runtime versions so the user can verify the environment without asking the agent.

---
