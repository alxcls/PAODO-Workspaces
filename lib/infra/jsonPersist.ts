// Atomic JSON persistence: write to a .tmp file then rename to avoid partial writes on crash.
import { mkdirSync, writeFileSync, renameSync } from "fs";
import path from "path";

export function atomicSaveJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}
