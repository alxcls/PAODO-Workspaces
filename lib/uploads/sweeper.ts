// Sweeps orphaned upload temp files out of WORKSPACES_ROOT. upload.ts cleans up its own temp
// file when a request fails, but a process kill mid-upload (OOM, deploy, restart) skips that catch
// block entirely and leaks the ".part" file forever — this is the janitor that reclaims it.
//
// Follows the same in-process tick convention as scheduler.ts and proxyReconciler.ts: a
// globalSingleton timer, unref'd so it never holds the process open, with an in-flight guard so a
// slow tick can't overlap the next one.
import fs from "fs/promises";
import path from "path";
import { createLogger } from "../infra/logger";
import { globalSingleton } from "../infra/globalSingleton";
import { WORKSPACES_ROOT } from "../infra/paths";

const log = createLogger("uploadSweeper");

const DEFAULT_TICK_MS = 30 * 60_000;
// Comfortably longer than server.ts's request timeout for uploads, so a sweep can never catch a
// file that is still genuinely being written.
const DEFAULT_STALE_MS = 2 * 60 * 60_000;

// Matches the temp file name upload.ts creates: `${resolved}.${randomBytes(6).toString("hex")}.part`.
const PART_FILE = /\.[0-9a-f]{12}\.part$/;

type SweeperState = { timer: NodeJS.Timeout | null; running: boolean };
const state = globalSingleton<SweeperState>("uploadSweeperState", () => ({ timer: null, running: false }));

async function removeStaleParts(dir: string, staleBeforeMs: number): Promise<number> {
  let removed = 0;
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ err, dir }, "upload sweep could not read directory");
    return removed;
  }

  for (const entry of entries) {
    if (entry.name === ".git") continue; // never touched by uploads; walking it is pure cost
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await removeStaleParts(full, staleBeforeMs);
      continue;
    }
    if (!entry.isFile() || !PART_FILE.test(entry.name)) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs > staleBeforeMs) continue;
      await fs.rm(full, { force: true });
      removed += 1;
    } catch (err) {
      log.warn({ err, file: full }, "upload sweep could not remove stale temp file");
    }
  }
  return removed;
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const staleMs = parseInt(process.env.UPLOAD_SWEEP_STALE_MS ?? String(DEFAULT_STALE_MS), 10) || DEFAULT_STALE_MS;
    const removed = await removeStaleParts(WORKSPACES_ROOT, Date.now() - staleMs);
    if (removed > 0) log.info({ removed }, "upload sweep removed orphaned temp files");
  } catch (err) {
    log.warn({ err }, "upload sweep tick failed");
  } finally {
    state.running = false;
  }
}

/** Start the sweep loop. Idempotent. */
export function startUploadSweeper(): void {
  if (state.timer) return;
  const tickMs = parseInt(process.env.UPLOAD_SWEEP_TICK_MS ?? String(DEFAULT_TICK_MS), 10) || DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "upload sweeper started");
}

export function stopUploadSweeper(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("upload sweeper stopped");
}

// Exported for tests to drive a single sweep deterministically.
export { tick as _tick };
