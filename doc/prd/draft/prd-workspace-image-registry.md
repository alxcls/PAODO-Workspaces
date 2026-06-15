# PRD — Workspace image registry & CI build pipeline

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

The workspace container image (`paodo-workspace`) is currently built directly on the VPS every time `Dockerfile.workspace` changes. Each build leaves behind a large layer cache (currently 24GB on a single VPS) that accumulates indefinitely. As the product scales to more VPS instances, every node independently rebuilds the same image, multiplying the wasted storage and build time. The VPS should be running workspaces, not building images.

## Goals

- The workspace image is built once on CI and pushed to a container registry
- VPS nodes pull the pre-built image — no build toolchain or cache required on the host
- Container start time is unaffected (image already present on disk after first pull)
- Storage footprint on VPS is predictable and bounded

## Non-goals

- Multi-arch builds
- Automated base image updates or dependency scanning
- Per-workspace image variants
- Migrating the app image (`paodo_ws-app`) to the same pipeline (separate concern)

## User stories

> As an operator, I want the VPS to pull a pre-built workspace image on deploy so that I do not accumulate gigabytes of build cache on production nodes.

> As a developer, I want `Dockerfile.workspace` changes to trigger an automatic CI build so that the updated image is available on the VPS without manual intervention.

> As an operator, I want the VPS to always run the latest pushed image so that new workspaces pick up the latest system packages automatically.

## Requirements

### Must have

- CI pipeline (GitHub Actions) builds `paodo-workspace` on every push to `main` that touches `Dockerfile.workspace`
- Built image is pushed to a container registry (e.g. GitHub Container Registry)
- VPS pulls the image on deploy rather than building locally
- `containerManager.ts` image freshness check works against the pulled image tag rather than a local build hash
- Build cache on VPS can be fully pruned — zero impact on workspace boot time

### Nice to have

- Image tagged with git SHA for rollback
- Scheduled weekly rebuild to pick up upstream Ubuntu package updates
- CI layer cache (`cache-from`/`cache-to`) — deferred until rebuild frequency justifies it; cold builds are ~5–10 min but `Dockerfile.workspace` changes rarely

## Notes

- Current VPS disk profile: ~1.22GB image (shared), ~4–200MB writable layer per workspace, 24GB build cache (reclaimable once CI pipeline is in place)
- `containerManager.ts` already handles image-not-found by building locally — this fallback can remain as a dev-only path behind an env flag
