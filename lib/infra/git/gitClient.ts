// Low-level git CLI wrapper: spawns git subprocesses and captures stdout/stderr/exit code.
// Mirrors dockerClient._spawn (same sync-throw guard + proc.on("error") handling) so no new
// dependency is pulled in. Defines IGitClient so WorkspaceVersioning can swap in a fake for
// tests without spawning real git. This is a dumb spawner: the caller supplies the full arg
// list (including --git-dir/--work-tree); it knows nothing about workspaces or paths.
import { spawn } from "child_process";

export type GitResult = { stdout: string; stderr: string; code: number };

export interface IGitClient {
  /** Runs `git <args>`. trimStdout defaults true (most git output we read is line-oriented). */
  run(args: string[], opts?: { trimStdout?: boolean }): Promise<GitResult>;
}

export class GitClient implements IGitClient {
  run(args: string[], opts: { trimStdout?: boolean } = {}): Promise<GitResult> {
    const { trimStdout = true } = opts;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("git", args);
      } catch (err) {
        // spawn can throw synchronously (e.g. EBADF during Next.js compilation, or git absent)
        // before the child is created, so proc.on("error") never fires in that case.
        resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
        return;
      }
      proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.stdout!.on("error", () => {});
      proc.stderr!.on("error", () => {});
      proc.on("close", (code) =>
        resolve({
          stdout: trimStdout ? stdout.trim() : stdout,
          stderr: stderr.trim(),
          code: code ?? 1,
        }),
      );
      proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
      proc.stdin!.end();
    });
  }
}
