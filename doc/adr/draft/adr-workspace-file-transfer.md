# ADR: Workspace file transfer (push/pull) from the external CLI

Status: Proposed
Date: 2026-08-05

Context

A coding agent holding the CLI needs to move a directory tree in and out of a workspace without
touching the UI: `paodo pull <id>` to fetch the tree, `paodo push <id> <dir>` to send new and changed
files, `--mirror` to additionally delete remote files absent locally, `--into <subtree>` to bound a
mirror, `--dry-run` to print the plan, `--yes` for unattended runs.

Every file route is UI-only today, and the three existing traversals disagreed about what a workspace
contains: the file tree hid `.git` and the Python caches and stopped at 5 levels, a folder upload
left out `node_modules`/`.venv`/framework build dirs, and the download ZIP filtered nothing. A
push/pull pair built on three answers drifts on every round trip — you pull a tree that omits a
directory, push it back, and a mirroring push then wants to delete files it was never shown.

Decision (settled, and already in the tree)

- One ignore contract, `lib/files/ignore.ts`, read by every walker, archiver and uploader in both
  directions. Directory-name rules plus file-suffix rules, exported as one `IGNORE_CONTRACT` value so
  it can be served to a client rather than copied into it.
- `.git` does not travel. A workspace's own repo is the agent's, not our snapshot store
  (`<root>/.versioning/<id>`, outside the tree), and moving an object store file-by-file turns a
  half-applied push into a corrupt repo rather than an incomplete tree. History is reachable through
  the snapshot/restore operations. One line to flip, and both directions flip together.
- No implicit depth cap. `buildTree` takes `maxDepth`; the 5-level limit is the file _panel's_ budget,
  named as such, and a manifest walk passes `Infinity`. A silently truncated walk means a nested
  project diverges without anyone being told.
- One descriptor budget for all traversals (`lib/files/fdLimit.ts`), so a fan-out cannot hit EMFILE
  and present a short answer as a complete one.
- Snapshots can be flushed, not only coalesced (`flushSnapshotBurst`). The 2s quiet-period coalescer
  is right when nobody says the burst is over (a browser folder upload never does); a transfer that
  knows it sent its last file needs exactly one commit however long it took, awaited, so the response
  can name the revision a bad push is restored from.
- CLI options are declared per command (`cli/src/args.mjs`) and anything undeclared is a usage error.
  A mistyped `--mirrror` must not read as a plain copy.

Open decisions (these change the shape of the work)

1. **Do executable bits and empty directories need to survive a push?** If yes, the current
   one-file-per-request upload path cannot deliver it at all: tar stops being a performance question
   and becomes a correctness requirement, and step 5 below becomes a new archive-upload endpoint with
   per-entry containment (each entry re-validated through `resolveContained`, never trusting
   caller-named archive paths). If no, per-file uploads stand.
2. **`paodo rm` is already workspace deletion.** The plan's `paodo rm <id> <path>` would overload one
   verb across two arities where the shorter one is irreversible — forget the path and you delete the
   workspace. File deletion needs its own verb, or workspace deletion needs a flag.

Remaining build order (server first; the CLI is a thin client of it)

1. Manifest endpoint — relative path, size, content hash, no depth cap. The only genuinely new
   capability; everything else depends on it.
2. Serve the effective ignore contract.
3. Batch the snapshot around a push so it is one commit (`flushSnapshotBurst` is the seam).
4. Four policy lines in `platformAccessPolicy.ts` — manifest, download, upload, content DELETE (use
   `workspaceRule`).
5. The upload path, per decision 1 above.
6. The CLI commands, with bounded upload concurrency and honest progress.

Consequences

- Only files whose content hash differs transfer, so a steady-state push is a handful of requests.
- Deletion never happens without an explicit flag, and a mirroring push snapshots first, so a bad
  push is recoverable through restore.
- Visible today, before any transfer exists: the file panel and the download ZIP now hide what a
  transfer would skip (`node_modules`, `.venv`, framework build dirs), and a browser folder upload no
  longer sends a `.git` the panel would refuse to show. The upload summary names the rule that
  excluded each group, so none of it is silent.
- A workspace's own git history can no longer be moved by a file transfer in either direction.

Alternatives considered

- Keep per-surface ignore lists and reconcile only inside the transfer code — rejected: it leaves the
  drift in place and puts a fourth answer next to the three that already disagree.
- Push as a ZIP/tar upload from day one — deferred to decision 1: per-file requests keep memory flat
  on both ends, let each file fail and retry on its own, and remove the zip-slip surface that
  caller-named archive entries create (see `lib/uploads/upload.ts`).
- Express deletion as a push from an empty directory — rejected: `--mirror` already means "make the
  remote match", and a path typo in a plain push must never be able to delete.

Notes

Related: `adr-upload-folder-file-architecture.md` (stale on limits and ZIP mode — worth revisiting
alongside step 5). Parked, not dropped: 24-hour auto-revoke on workspace channels, and the
fleet-wide channel roll-up that makes stale ones visible.

Files: `lib/files/ignore.ts`, `lib/files/entries.ts`, `lib/files/fdLimit.ts`, `lib/files/tree.ts`,
`lib/files/zip.ts`, `lib/infra/git/snapshotWorkspace.ts`,
`lib/infra/security/platformAccessPolicy.ts`, `cli/src/args.mjs`, `cli/src/client.mjs`,
`cli/src/http.mjs`
