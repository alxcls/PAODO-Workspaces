# PRD — Database Storage

**Status:** Draft
**Author:** @alxcls
**Related:** [VISION.md](../VISION.md), [prd-workspace-isolation.md](prd-workspace-isolation.md), [prd-api-access.md](prd-api-access.md)

---

## Problem

Platform metadata — workspace registry, API keys, and the agent network graph — is stored in JSON files with an in-memory cache as the source of truth. This works for a single admin managing the platform. It breaks as soon as more than one person can create workspaces or manage keys at the same time: the in-memory cache is per-process, so concurrent managers on separate instances would corrupt each other's state.

## Goals

- Multiple users or admins can manage the platform concurrently without corrupting state
- The platform supports multi-instance deployment without shared in-memory state
- Self-hosting remains simple — no external database server required

## Non-goals

- Storing agent-generated files or workspace file trees — those stay on disk
- Storing conversation history or todo lists — those are ephemeral by design

## User stories

> As a platform operator, I want two admins to be able to create workspaces at the same time without one overwriting the other's changes.

> As a self-hoster running multiple server instances behind a load balancer, I want all instances to share a consistent view of workspaces and API keys.

> As a self-hoster, I want to back up all platform state with a single file copy.

## Requirements

### Must have

- Concurrent writes from multiple processes are safe — no silent clobber
- The platform boots cleanly with no manual repair step after an unclean shutdown
- No external database server is required to run the platform
- Existing behavior is fully preserved — no changes to the API or UI surface

### Nice to have

- Automatic migration from existing JSON files so no data is lost on upgrade
- Storage layer abstracted behind an interface to allow swapping backends without touching business logic
