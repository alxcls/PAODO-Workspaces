// Shared "create parent dirs, then write a file" step for the container-backed write tools
// (file_write and file_edit's create-file branch). Runs `mkdir -p` on the parent, then pipes the
// content to the target via `tee` inside the container.
//
// Returns null on success, or an "Error: …" string ready to return straight from the tool (the
// "Error:" prefix is load-bearing for classifyToolStatus). `relpath` must already be a normalized,
// workspace-relative path (see normalizeRelpath) — this does not re-validate containment.
import path from "path";
import type { ExecRunner } from "../interfaces";
import { toolError } from "../toolUtils";
import { requireFreeSpace } from "@/lib/infra/storage/diskSpace";

export async function writeContainerFile(
  runner: ExecRunner,
  workspaceDir: string,
  relpath: string,
  content: string,
): Promise<string | null> {
  try {
    const spaceErr = await requireFreeSpace(workspaceDir, Buffer.byteLength(content));
    if (spaceErr) return spaceErr;

    const dirRelpath = path.posix.dirname(relpath);
    if (dirRelpath && dirRelpath !== ".") {
      const mkdirR = await runner.exec(["mkdir", "-p", `/workspace/${dirRelpath}`]);
      if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
    }
    const writeR = await runner.exec(["tee", `/workspace/${relpath}`], { stdin: content });
    if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
    return null;
  } catch (err) {
    return toolError(err);
  }
}
