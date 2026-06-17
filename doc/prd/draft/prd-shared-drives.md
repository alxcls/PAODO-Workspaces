# PRD — Shared Drives

**Status:** Draft  
**Author:** alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

Agents operate in isolated workspaces with no way to exchange files. When a pipeline involves multiple agents — one researching, another writing a report, another executing — there is no shared space to pass artifacts between them. Users have to manually copy outputs from one workspace to another.

## Goals

Let users create shared drives, connect them to multiple workspaces, and let agents exchange files through them — the same way people use SharePoint alongside their local machine.

## Non-goals

- Agent-to-agent signaling (agent A notifying agent B that a file is ready)
- Agent-created drives
- Access control per drive connection (all connections are read-write)
- Binary file support in v1

## User stories

- As a user, I can create a named shared drive from the graph UI and give it a description.
- As a user, I can connect a shared drive to one or more workspaces from the graph UI.
- As a user, I can disconnect or delete a shared drive.
- As an agent, I can list the drives connected to my workspace and browse their contents.
- As an agent, I can read a file from a drive directly into my context (quick read, no local copy).
- As an agent, I can write content directly to a drive file (quick write, no local copy).
- As an agent, I can download a drive file into my local workspace to work on it with my existing tools.
- As an agent, I can upload a file from my local workspace to a drive to share it with other agents.
- As an agent, I can delete a file or folder from a drive.

## Requirements

### Must have

**Shared drive management (UI)**
- Create a drive with a name and optional description
- Connect / disconnect a drive from a workspace
- Delete a drive
- Drives appear as nodes in the graph UI with a folder icon, edges represent connections to workspaces

**Agent tools — injected only when ≥1 drive is connected**

| Tool | What it does |
|---|---|
| `drive_ls` | No args: list connected drives. With drive + path: list directory contents |
| `drive_read` | Read a file's text content into agent context |
| `drive_write` | Write text content to a file, creating parent directories automatically |
| `drive_delete` | Delete a file or folder |
| `drive_download` | Copy a file from a drive into the workspace at `downloads/<drive-name>/<path>` |
| `drive_upload` | Copy a file from the workspace into a drive |

**System prompt injection**
- When a workspace has connected drives, inject their names, descriptions, and most recent file activity so the agent knows what to look for without exploring blindly.
- Frame it as: "Your workspace is your local machine. Drives are shared spaces — pull files to work on them, push results back."

### Nice to have

- Binary file support for download/upload
- Drive file browser in the UI
- Drive activity log (which agent wrote what and when)
- Agent-to-agent signaling when a file is ready
