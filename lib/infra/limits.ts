// Every app-side ceiling on memory this process will hold, in one file.
//
// They live together because the question they answer is a whole-system one — "does every path that
// accumulates have a bound?" — and that question was answered wrong twice. gitClient kept the
// unbounded append for a commit after dockerClient was fixed, because each spawner owned its own copy
// of the number and fixing one said nothing about the other. Then the drive tools turned out to read
// host-side, so every ceiling added around the container transport missed them entirely. Both times
// the miss was invisible: there was nowhere to look and see the set.
//
// The split with the call sites is deliberate. What lives HERE is the number and why it is that
// number. What stays at the CALL SITE is the mechanism — how the cut is made, what happens to the
// remainder, what the agent is told. Reading an entry here should answer "why 8MB and not 80"; reading
// the call site should answer "what happens at byte 8,388,609".
//
// None of these is an env knob, deliberately (see doc/security_notes.md). Unlike CONTAINER_MEMORY,
// none depends on the host: every PAODO instance runs the same kinds of workloads, so each has one
// right answer, and an operator asked to pick would have nothing to base the choice on.
//
// Worth knowing while reading any number below: the app container declares no memory limit of its own
// (docker-compose.yml sets none), so nothing catches an overrun underneath these. The ceilings in this
// file ARE the limit, and passing one takes the whole instance — every workspace, socket and in-flight
// run — not a single workspace.

/**
 * Byte size for the message a ceiling produces — "29.4KB", "1.2MB". Mirrors Claude Code's KiB/MiB
 * rendering.
 *
 * It lives with the numbers because every ceiling here owes the caller the same sentence: what was
 * cut or refused, and how big it was. A ceiling that cannot say that produces the failure mode these
 * were introduced to avoid — an agent acting confidently on a partial picture — so the formatter is
 * part of the mechanism, not a presentation detail.
 */
export function formatOutputBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value}B` : `${(Math.round(value * 10) / 10).toFixed(1)}${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Subprocess capture — lib/infra/spawnCapture.ts (docker + git)
// ---------------------------------------------------------------------------

/**
 * What a single spawned child process may materialize in this process, per stream.
 *
 * A safety floor rather than a product limit: it exists so that an unbounded `stdout +=` cannot
 * reach V8's ~536M character limit and throw RangeError out of a stream handler, where no caller's
 * `.catch()` can see it. Tools that need a meaningful bound (file_read, execute_command) set a much
 * lower one of their own and this never comes into play for them; it only catches the paths nobody
 * thought to bound. Generous for that reason — 8MB is far more than any git or docker CLI invocation
 * legitimately prints, while still being a rounding error against the heap.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Command output — lib/agent/tools/execOutput.ts, execCommand.ts
// ---------------------------------------------------------------------------

/** Output at or under this stays inline in the tool result, whole. Matches Claude Code's threshold. */
export const MAX_INLINE_BYTES = 30_000;

/** How much of an over-cap output is shown inline, as a head preview. Claude Code shows 2KB. */
export const PREVIEW_BYTES = 2_048;

/**
 * How much stderr survives the spill, at each end.
 *
 * The spill drops the separated streams, which also dropped the only input diagnoseStderr has — so a
 * command that failed because the container cannot resolve its runtime user, and happened to print
 * more than the cap, got the "output too large" notice instead of the explanation of WHY it failed.
 * Head and tail because a failure announces itself at one end or the other: setup faults come first,
 * and a build that dies after 40KB of progress says why on its last line.
 */
export const STDERR_SAMPLE_BYTES = 2_048;

// ---------------------------------------------------------------------------
// Spill files — lib/infra/docker/containerManager.ts
// ---------------------------------------------------------------------------

/**
 * Ceiling on one spill file. Without it the "keep everything" promise would let a single command fill
 * the container's writable layer — which the mid-run disk check cannot see, since that watches the
 * workspace mount, not the container layer.
 */
export const EXEC_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How many spill files survive in a container. These containers are never auto-recreated, so this
 * directory would otherwise grow for the workspace's entire lifetime with nothing to clear it.
 *
 * KEEP × MAX_BYTES is the real number to judge these two by: it is what this feature can occupy in a
 * container's writable layer, the one space with no recovery path short of destroying the container.
 * 5 × 20MB = 100MB is the deliberate budget. Spill files are scratch — the agent greps the one it was
 * just handed — so a deeper history buys nothing worth that space.
 */
export const EXEC_OUTPUT_KEEP = 5;

/**
 * Ceiling on bytes queued for the sink but not yet drained into the container. Reached only when the
 * sink writes slower than the command produces; past it the file stops at a prefix. Without this the
 * backlog would sit in the app's heap, which is the exact failure this whole mechanism exists to stop.
 */
export const EXEC_OUTPUT_MAX_BACKLOG = 8 * 1024 * 1024;

/**
 * How long a killed command's process group is given to exit on SIGTERM before SIGKILL follows.
 *
 * Commands are killed routinely and without anyone asking — the silence and max-runtime guards and
 * the disk check all do it, alongside the user's Stop. Going straight to SIGKILL denies git the
 * chance to drop its index.lock and npm the chance to clear its staging dir, so the workspace is
 * left needing repair and the agent spends its next turns doing it. This window is what turns that
 * into a clean abort.
 *
 * Free, in latency terms: the kill is already fire-and-forget relative to the tool's return (see
 * execCommand's killWith), so nothing waits on this — not the user's Stop, not the agent's next turn.
 * Short all the same, because it delays only the forced kill of something already misbehaving.
 */
export const EXEC_KILL_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// File reads — lib/agent/tools/fileRead.ts, lib/agent/tools/driveRead.ts
// ---------------------------------------------------------------------------

/**
 * How much of a file one read may pull into the process, for `file_read` and `drive_read` alike.
 *
 * Both put bytes into the LLM's context, so the ceiling is set by what a context can absorb, not by
 * what the heap can survive — the same question, hence deliberately the same number rather than two
 * that drift. Generous because file_read sets skipResultCap so a legitimately large file still reads
 * in one call, which leaves this as the only thing bounding it; offset/limit is how you page past it.
 *
 * The two enforce it in different places, and that difference is the point: file_read applies it
 * inside the container with `head -c`, so an oversized file never crosses into this process at all,
 * while drive_read stats host-side before opening. Neither reads first and trims after — reading
 * first IS the bug.
 */
export const MAX_FILE_READ_BYTES = 400_000;

// ---------------------------------------------------------------------------
// Drive transfers — lib/agent/tools/driveDownload.ts, driveUpload.ts, driveLs.ts
// ---------------------------------------------------------------------------

/**
 * Ceiling on a file moved between a workspace and a shared drive.
 *
 * Judge this one by its peak, not by the file: drive_download holds the raw bytes, a base64 copy of
 * them (~1.33×, since exec stdin is text-only), and the copy the runner makes writing that to the
 * child — roughly 3.7× the file size, all live at the same moment. 50MB therefore costs ~185MB of
 * transient heap, which is the number this was chosen against. Raising it to 500MB would not cost
 * 500MB, it would cost 1.85GB and cross V8's string limit on the base64 copy on the way.
 *
 * Large enough for what drives are actually for — a dataset, a SQLite database, a build artifact
 * handed to the next agent. A file past it is a sign the work wants a different shape (split it, or
 * have the agent process it in place rather than moving it), and the tools say so when they refuse.
 */
export const MAX_DRIVE_TRANSFER_BYTES = 50 * 1024 * 1024;

/**
 * How many entries `drive_ls` renders for one directory.
 *
 * Bounds two things at once: the listing text, and the directory scan itself — the tool stops reading
 * at this many rather than materializing every Dirent of a drive holding a million files. An agent
 * cannot use more than this anyway; past it the useful move is narrowing the path, which the
 * truncation notice says.
 */
export const MAX_DRIVE_LISTING_ENTRIES = 1_000;

// ---------------------------------------------------------------------------
// Live console sockets — lib/infra/realtime/wsHub.ts
// ---------------------------------------------------------------------------

/**
 * How far behind a single socket may fall before we stop handing it more.
 *
 * 2MB is far past useful: the console panel keeps only the last 500 lines, so anything queued behind
 * that much backlog has already scrolled out of existence before it could be rendered. Dropping it
 * costs the viewer nothing real — and the drop is reported (console_dropped) rather than hidden.
 */
export const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * A socket pinned at the ceiling this long is not a slow viewer, it is a dead one that has not
 * finished dying (a closed laptop, a dropped network with no FIN). Terminating reclaims its buffer
 * and its slot; the browser hook reconnects 2s later and resyncs, so a live viewer loses nothing.
 */
export const WS_STALL_MS = 30_000;
