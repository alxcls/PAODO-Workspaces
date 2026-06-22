# PRD — Rate limiting and upload control

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [prd-api-access.md](prd-api-access.md), [prd-workspace-isolation.md](prd-workspace-isolation.md)

## Overview

This short PRD documents the current absence of rate limiting and upload controls for files and folders in the platform. It captures the problem, risk, and a minimal set of requirements to address it.

## Problem

There is no global or per-workspace rate limiting on API calls, nor any controls that restrict or validate the size, type, or number of files and folders users can upload into a workspace. This enables accidental or malicious large uploads and repeated requests that can exhaust CPU, memory, disk, or network resources.

## Impact

- Resource exhaustion (disk, memory, bandwidth)
- Increased operational cost and potential degraded performance for other users
- Higher security risk from large/malicious content
- Harder to enforce storage quotas and fair-use policies

## Requirements (minimal)

1. Implement per-workspace and global rate limiting for API/shell/file operations (requests/minute or requests/sec)
2. Enforce upload limits: max file size, max total upload per workspace, and max number of files per upload
3. Validate accepted file types and provide configurable allow/block lists
4. Return clear HTTP error codes and messages when limits are exceeded
5. Provide admin tooling or config files to tune limits per-deployment

## Acceptance criteria

- Requests exceeding limits are rejected with 429 and a descriptive message
- Uploads larger than the configured limits are rejected with 413 (Payload Too Large)
- Default limits exist and are documented; operators can override them via config

## Next steps

1. Inventory current endpoints and file upload paths (server, agent, web UI)
2. Prototype rate limiting middleware (token bucket/LEAKY BUCKET) and test under load
3. Add upload-size checks at middleware and storage layers; surface errors to the UI
4. Document defaults in ops runbook and add metrics/alerts for limit breaches
