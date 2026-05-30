# PRD — Workspace Secrets

**Status:** Draft  
**Author:** @alxcls  
**Related:** [prd-workspace-isolation.md](../accepted/prd-workspace-isolation.md), [prd-api-access.md](../accepted/prd-api-access.md)

---

## Problem

There is currently no safe way to give an agent access to secrets (API keys, tokens, credentials). The only option is to write them into a `.env` file inside the workspace directory. Because the agent has full read access to that directory, it can — and will — read those values as plaintext. Any secret placed there is immediately visible to the LLM, which means it can appear in tool outputs, reasoning traces, or agent-to-agent messages.

---

## Goals

- Secrets are stored outside the workspace directory so the agent cannot read them as files
- Secrets are still available to shell commands as environment variables (e.g. `aws s3 ls` works because `AWS_ACCESS_KEY_ID` is set in the container environment)
- The UI provides a per-workspace secrets panel to create, update, and delete secrets
- Secret values are never returned to the frontend after creation — only the key names are displayed

---

## Non-goals

- Global or cross-workspace secrets — each workspace manages its own
- Encryption at rest beyond what the host filesystem provides — this is a self-hosted platform
- Secret rotation, expiry, or audit logging

---

## User stories

> As a citize developer, I want to give my agent access to my AWS credentials so it can run `aws` CLI commands, without those credentials ever appearing in the agent's context window.

> As a citizen developer, I want to manage my workspace secrets from the UI without touching any file inside the workspace directory.

> As a citizen developer, when I revisit the secrets panel I want to see which keys are configured, but not their values.

---

## How it works today

Secrets must be written to a `.env` file inside `./data/<workspace>/`. The agent's working directory is that same folder, so `cat .env` or any file-read tool exposes all values directly to the LLM. There is no UI for this; it requires manually editing the file or asking the agent to do it (which means the agent sees the value in the conversation).

---

## Requirements

### Must have

- Secrets are stored in the workspace metadata store (`lib/infra/`), outside the workspace's file directory — never as a file the agent can read
- At container startup, secrets are injected into the container as environment variables via `docker run -e` (or equivalent) — the agent can run commands that use them, but cannot enumerate or print them through file access
- The workspace settings UI includes a **Secrets** section where the user can add a key/value pair, see a list of existing key names (values masked), and delete individual secrets
- Secret values are write-only from the UI: on load, the panel shows key names only; to update a value the user overwrites it

### Nice to have

- Warn the user if a secret name collides with a variable already set in the base container image
- Bulk import from a `.env` file via paste (values are parsed and stored server-side, the file itself is not written into the workspace)

---
