// Manages per-workspace chokidar file watchers that broadcast filesystem changes to WebSocket clients.
// Batches change and delete events with a 150ms debounce. Suppresses events for files the agent just wrote
// to prevent the file viewer from reloading content the agent is still editing.
import chokidar, { type FSWatcher } from "chokidar";
import fs from "fs";
import { broadcastToWorkspace } from "./wsHub";

const WATCHERS_DISABLED = process.env.DISABLE_WS_FILE_WATCH === "1";

interface WatcherEntry {
  watcher: FSWatcher;
  flushTimeout: ReturnType<typeof setTimeout> | null;
  pendingChanged: Set<string>;
  pendingDeleted: Set<string>;
}

const watchers = new Map<string, WatcherEntry>();
const ignorePaths = new Map<string, number>();

function scheduleFlush(entry: WatcherEntry, workspaceId: string): void {
  if (entry.flushTimeout !== null) return;
  entry.flushTimeout = setTimeout(() => {
    entry.flushTimeout = null;
    const changed = [...entry.pendingChanged];
    const deleted = [...entry.pendingDeleted];
    entry.pendingChanged.clear();
    entry.pendingDeleted.clear();
    if (changed.length > 0) {
      broadcastToWorkspace(workspaceId, JSON.stringify({ type: "files_changed", paths: changed }));
    }
    if (deleted.length > 0) {
      broadcastToWorkspace(workspaceId, JSON.stringify({ type: "files_deleted", paths: deleted }));
    }
  }, 150);
}

export function ensureWatcher(workspaceId: string, dir: string): void {
  if (WATCHERS_DISABLED || watchers.has(workspaceId)) return;

  const entry: WatcherEntry = {
    watcher: null!,
    flushTimeout: null,
    pendingChanged: new Set(),
    pendingDeleted: new Set(),
  };

  const watcher = chokidar.watch(dir, {
    ignored: /(node_modules|\.git|\.next|dist|build)/,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", (absPath: string) => {
    entry.pendingChanged.add(absPath);
    scheduleFlush(entry, workspaceId);
  });

  watcher.on("change", (absPath: string) => {
    const expiry = ignorePaths.get(absPath);
    if (expiry !== undefined) {
      if (Date.now() < expiry) return;
      ignorePaths.delete(absPath);
    }
    entry.pendingChanged.add(absPath);
    scheduleFlush(entry, workspaceId);
  });

  watcher.on("unlink", (absPath: string) => {
    setTimeout(() => {
      try {
        fs.accessSync(absPath);
        entry.pendingChanged.add(absPath);
      } catch {
        entry.pendingDeleted.add(absPath);
      }
      scheduleFlush(entry, workspaceId);
    }, 200);
  });

  watcher.on("error", (err: unknown) => {
    console.error(`[workspaceWatcher] error for ${workspaceId}`, err);
  });

  entry.watcher = watcher;
  watchers.set(workspaceId, entry);
}

export function stopWatcher(workspaceId: string): void {
  if (WATCHERS_DISABLED) return;
  const entry = watchers.get(workspaceId);
  if (!entry) return;
  if (entry.flushTimeout !== null) clearTimeout(entry.flushTimeout);
  entry.watcher.close();
  watchers.delete(workspaceId);
}

export function markSelfWrite(absPath: string): void {
  if (WATCHERS_DISABLED) return;
  ignorePaths.set(absPath, Date.now() + 500);
}

export function stopAllWatchers(): void {
  for (const entry of watchers.values()) {
    if (entry.flushTimeout !== null) clearTimeout(entry.flushTimeout);
    entry.watcher.close();
  }
  watchers.clear();
  ignorePaths.clear();
}
