// Low-level git CLI wrapper: spawns git subprocesses and captures stdout/stderr/exit code.
// Mirrors dockerClient._spawn (same sync-throw guard + proc.on("error") handling) so no new
// dependency is pulled in. Defines IGitClient so WorkspaceVersioning can swap in a fake for
// tests without spawning real git. This is a dumb spawner: the caller supplies the full arg
// list (including --git-dir/--work-tree); it knows nothing about workspaces or paths.
//
// The capture is bounded by the SHARED helper, not a local copy. Mirroring dockerClient is how this
// file inherited an unbounded `stdout += d.toString()` in the first place, and why capping
// dockerClient alone left `git diff` — reachable in one agent tool call, on a file the agent itself
// wrote — able to take the instance down. See lib/infra/spawnCapture.ts.
import { spawn } from "child_process";
import { SpawnCapture } from "../spawnCapture";

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
  /** True when output hit the capture ceiling and stdout holds only the leading part. */
  truncated?: boolean;
};

export interface IGitClient {
  /** Runs `git <args>`. trimStdout defaults true (most git output we read is line-oriented). */
  run(args: string[], opts?: { trimStdout?: boolean }): Promise<GitResult>;
}

export class GitClient implements IGitClient {
  run(args: string[], opts: { trimStdout?: boolean } = {}): Promise<GitResult> {
    const { trimStdout = true } = opts;
    return new Promise((resolve) => {
      const captured = new SpawnCapture();
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("git", args);
      } catch (err) {
        // spawn can throw synchronously (e.g. EBADF during Next.js compilation, or git absent)
        // before the child is created, so proc.on("error") never fires in that case.
        resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
        return;
      }
      captured.attach(proc);
      proc.on("close", (code) =>
        resolve({
          stdout: trimStdout ? captured.stdout.trim() : captured.stdout,
          stderr: captured.stderr.trim(),
          code: code ?? 1,
          truncated: captured.truncated,
        }),
      );
      proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
      proc.stdin!.end();
    });
  }
}
