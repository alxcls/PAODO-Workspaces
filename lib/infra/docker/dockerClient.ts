// Low-level Docker CLI wrapper: spawns docker subprocesses and captures stdout/stderr/exit code.
// Defines IDockerClient so ContainerManager can swap in a fake for tests without spawning real Docker.
import { spawn } from "child_process";
import { SpawnCapture } from "../spawnCapture";

export type DockerResult = {
  stdout: string;
  stderr: string;
  code: number;
  /** True when output hit the capture ceiling and stdout holds only the leading part. */
  truncated?: boolean;
};

export type DockerStdin = string | Uint8Array;

export interface IDockerClient {
  cmd(...args: string[]): Promise<DockerResult>;
  exec(
    containerName: string,
    cmdArgs: string[],
    opts?: { stdin?: DockerStdin; asRoot?: boolean; cwd?: string; trimStdout?: boolean; env?: Record<string, string> },
  ): Promise<DockerResult>;
  build(buildArgs: string[], dockerfile: Buffer): Promise<void>;
}

/**
 * Expand an env map into `-e NAME=value` argv pairs for `docker exec`.
 * Exported because execStreaming builds its own argv rather than going through exec().
 */
export function envArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

export class DockerClient implements IDockerClient {
  // Single spawn+collect implementation used by all methods.
  // trimStdout=false preserves exact content (trailing newlines matter for file reads).
  private _spawn(args: string[], opts: { stdin?: DockerStdin; trimStdout?: boolean } = {}): Promise<DockerResult> {
    return new Promise((resolve) => {
      // Bounded, and bounded in ONE shared place rather than per spawner: these handlers are invoked
      // directly by Node, so a throw in one does not reach the promise this returns — it reaches the
      // uncaughtException guard in server.ts, which exits. See lib/infra/spawnCapture.ts.
      const captured = new SpawnCapture();
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("docker", args);
      } catch (err) {
        // spawn can throw synchronously (e.g. EBADF during Next.js compilation) before
        // the child process is created, so proc.on("error") never fires in that case.
        resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
        return;
      }
      captured.attach(proc);
      proc.on("close", (code) =>
        resolve({
          stdout: opts.trimStdout ? captured.stdout.trim() : captured.stdout,
          stderr: captured.stderr.trim(),
          code: code ?? 1,
          truncated: captured.truncated,
        }),
      );
      proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
      if (opts.stdin !== undefined) {
        proc.stdin!.write(opts.stdin, () => proc.stdin!.end());
      } else {
        proc.stdin!.end();
      }
    });
  }

  /** Generic docker command (inspect, network, port, build flags, …). Trims stdout. */
  cmd(...args: string[]): Promise<DockerResult> {
    return this._spawn(args, { trimStdout: true });
  }

  /**
   * docker exec inside a running container.
   * - asRoot=true  → adds -u 0
   * - cwd          → -w flag (default /workspace)
   * - trimStdout   → default false so file reads preserve trailing newlines;
   *                  pass true for commands where stdout is a short scalar (e.g. apt-get).
   * - env          → -e pairs; this is how workspace secrets reach the container, since the
   *                  container itself is long-lived and its creation-time env cannot be amended.
   */
  exec(
    containerName: string,
    cmdArgs: string[],
    opts: {
      stdin?: DockerStdin;
      asRoot?: boolean;
      cwd?: string;
      trimStdout?: boolean;
      env?: Record<string, string>;
    } = {},
  ): Promise<DockerResult> {
    const { stdin, asRoot = false, cwd = "/workspace", trimStdout = false, env } = opts;
    const args = ["exec", "-i"];
    if (asRoot) args.push("-u", "0");
    args.push(...envArgs(env), "-w", cwd, containerName, ...cmdArgs);
    return this._spawn(args, { stdin, trimStdout });
  }

  /** docker build piping a Dockerfile on stdin (empty build context via "-"). */
  build(buildArgs: string[], dockerfile: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("docker", buildArgs, { stdio: ["pipe", "inherit", "inherit"] });
      proc.on("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`docker build exited with code ${code}`));
      });
      proc.on("error", reject);
      proc.stdin!.write(dockerfile);
      proc.stdin!.end();
    });
  }
}
