# ADR — Symlink resolution before workspace boundary check

Status: Accepted

## Context

File tools (`fileRead`, `fileEdit`, `fileWrite`) validate that requested paths stay within the workspace directory. Without resolving symlinks first, an agent could create a symlink pointing outside the workspace and then read/write through it while the path check sees only the in-workspace symlink path.

## Decision

All file tools call `fs.realpath()` on the requested path before the workspace boundary check. The resolved absolute path (symlink target) is what gets validated and then operated on — not the original path.

Order matters: `realpath` → boundary check → operation. Doing the boundary check first on the unresolved path and then calling `realpath` opens a window where a symlink passes the check but writes outside the workspace.

## Consequences

- Symlink traversal outside the workspace is blocked regardless of how deeply the symlink is nested.
- Broken symlinks cause `realpath` to throw; file tools surface this as a clean error.
- Legitimate in-workspace symlinks work normally as long as their targets are also within the workspace.

## Alternatives considered

- Check the unresolved path only: allows symlink traversal attacks.
- Disallow symlinks entirely: overly restrictive for valid use cases (e.g., shared config files linked within the workspace).
