# PRD — Opaque Folders (Agent-Blind Data)

**Status:** Draft  
**Author:** alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

Professional services firms cannot expose client data to an LLM due to NDAs, GDPR, or internal policy. Today the agent reads any file it can access, which blocks adoption in these contexts entirely.

## Goals

Allow users to mark folders as opaque. Any file inside an opaque folder — whether created by the agent, dropped in externally, or moved there — is invisible to the agent. The agent can still run scripts that process those files; it just cannot read their contents.

## Non-goals

- Per-file opacity toggles
- Hiding the existence of opaque folders from the agent
- Preventing the agent from writing scripts that reference opaque files by path

## How it works

The folder structure enforces the data boundary. A typical workspace layout:

```
/scripts/     ← agent reads and writes freely
/incoming/    ← opaque — client data lands here
/outgoing/    ← opaque — processed output lives here
/logs/        ← agent reads freely — routing tokens written here by scripts
```

Any file inside an opaque folder inherits opacity automatically, regardless of how it got there. The agent reasons on filenames, folder paths, and routing tokens — never on data content.

**Routing token pattern** — scripts output a structured one-line token to `/logs/` instead of returning raw data:
```
STATUS:OK  ROUTE:ERP_FRANCE  RECORDS:42
```
The agent reads this token to decide next steps. Data never enters the LLM context.

## User stories

- As a consultant, I want to mark `/incoming/` as opaque so any client data dropped there is never read by the agent.
- As a service builder, I want to configure the opaque folders once in AGENTS.md and never think about it again.
- As a service provider, I want to show a client that data in opaque folders is guaranteed to never enter the LLM context.

## Requirements

### Must have

- Users can mark any folder as opaque in the workspace file tree
- All files inside an opaque folder are treated as opaque — no exceptions, no per-file overrides
- When the agent attempts to read a file in an opaque folder, it receives a hard refusal with no content
- Opaque folders are visually distinct in the file tree (crossed-eye icon on the folder)
- The agent can still run shell commands and scripts that reference opaque files by path

### Nice to have

- A notice in the agent chat bubble when a read was blocked: _"Contents not seen by agent"_
