import path from "path";

/** Storage and mutation hooks shared by workspace and drive file endpoints. */
export interface FileBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Workspace-only fallback for legacy root-owned files. It must never create a missing path.
  writeFallback?: (resolved: string, content: string) => Promise<void>;
  // Workspace git snapshot hook. Drives intentionally omit it.
  afterWrite?: (message: string) => Promise<void>;
}

/** Convert a client path into the lexical path space served by the file tree. */
export function lexicalFilePath(be: FileBackend, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(be.dir, filePath);
}
