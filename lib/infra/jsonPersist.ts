// Atomic JSON persistence: write to a .tmp file then rename to avoid partial writes on crash.
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("persistence");

export function atomicSaveJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

// Read a JSON file, returning `fallback` if it is missing or unparseable. The counterpart to
// atomicSaveJson for the many stores that load a JSON blob at startup with a "start empty on miss"
// policy. Stores needing to distinguish error kinds (e.g. ENOENT vs corrupt) keep their own read.
export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    // A missing file is the normal first-run case. Corruption, permissions, and I/O failures are
    // not: keep the existing fallback behavior, but never make persisted state disappear silently.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error({ err, filePath }, "failed to load persisted JSON — using fallback");
    }
    return fallback;
  }
}
