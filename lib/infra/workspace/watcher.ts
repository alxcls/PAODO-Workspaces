// Manages per-workspace chokidar file watchers that broadcast filesystem changes to WebSocket clients.
// Batches change and delete events with a 150ms debounce. Suppresses events for files the agent just wrote
// to prevent the file viewer from reloading content the agent is still editing.
import chokidar from "chokidar";
import fs from "fs";
import { broadcastToWorkspace } from "../realtime/wsHub";
import { createLogger } from "../logger";

const log = createLogger("watcher");

const WATCHERS_DISABLED = process.env.DISABLE_WS_FILE_WATCH === "1";

// Shared across all watcher instances — tracks paths the agent just wrote so we skip the echo event.
const ignorePaths = new Map<string, number>();

class WorkspaceWatcher {
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingChanged = new Set<string>();
  private pendingDeleted = new Set<string>();
  private watcher = chokidar.watch(this.dir, {
    ignored: /(node_modules|\.git|\.next|dist|build)/,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  constructor(
    private workspaceId: string,
    private dir: string,
  ) {
    this.watcher.on("add", (absPath: string) => {
      this.pendingChanged.add(absPath);
      this.scheduleFlush();
    });

    // Directory events matter for file-tree-only changes such as moving an empty folder. Without
    // them, another open browser would never be told to refresh its tree.
    this.watcher.on("addDir", (absPath: string) => {
      this.pendingChanged.add(absPath);
      this.scheduleFlush();
    });

    this.watcher.on("change", (absPath: string) => {
      const expiry = ignorePaths.get(absPath);
      if (expiry !== undefined) {
        if (Date.now() < expiry) return;
        ignorePaths.delete(absPath);
      }
      this.pendingChanged.add(absPath);
      this.scheduleFlush();
    });

    this.watcher.on("unlink", (absPath: string) => {
      setTimeout(() => {
        try {
          fs.accessSync(absPath);
          this.pendingChanged.add(absPath);
        } catch {
          this.pendingDeleted.add(absPath);
        }
        this.scheduleFlush();
      }, 200);
    });

    this.watcher.on("unlinkDir", (absPath: string) => {
      this.pendingDeleted.add(absPath);
      this.scheduleFlush();
    });

    this.watcher.on("error", (err: unknown) => {
      log.error(
        { event: "workspace_watcher_failed", outcome: "file_updates_may_be_stale", workspaceId, err },
        "watcher error",
      );
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimeout !== null) return;
    this.flushTimeout = setTimeout(() => {
      this.flushTimeout = null;
      const changed = [...this.pendingChanged];
      const deleted = [...this.pendingDeleted];
      this.pendingChanged.clear();
      this.pendingDeleted.clear();
      if (changed.length > 0) {
        broadcastToWorkspace(this.workspaceId, JSON.stringify({ type: "files_changed", paths: changed }));
      }
      if (deleted.length > 0) {
        broadcastToWorkspace(this.workspaceId, JSON.stringify({ type: "files_deleted", paths: deleted }));
      }
    }, 150);
  }

  close(): void {
    if (this.flushTimeout !== null) clearTimeout(this.flushTimeout);
    this.watcher.close();
  }
}

const watchers = new Map<string, WorkspaceWatcher>();

export function ensureWatcher(workspaceId: string, dir: string): void {
  if (WATCHERS_DISABLED || watchers.has(workspaceId)) return;
  watchers.set(workspaceId, new WorkspaceWatcher(workspaceId, dir));
}

export function stopWatcher(workspaceId: string): void {
  if (WATCHERS_DISABLED) return;
  watchers.get(workspaceId)?.close();
  watchers.delete(workspaceId);
}

export function markSelfWrite(absPath: string): void {
  if (WATCHERS_DISABLED) return;
  ignorePaths.set(absPath, Date.now() + 500);
}

export function stopAllWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  ignorePaths.clear();
}
