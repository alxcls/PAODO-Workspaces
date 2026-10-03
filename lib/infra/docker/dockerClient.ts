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

// Root execs get a fixed env, never the container's: its PATH reaches agent-writable dirs, and so
// could any var added later. Values travel by -e only, since /proc/<pid>/cmdline is world-readable.
const ROOT_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", DEBIAN_FRONTEND: "noninteractive" };
// The egress route, set by the app at docker run: apt has no other way off the workspace network.
const ROOT_INHERITED = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];
// Unsets every variable not named in $1, then runs the command.
const ROOT_WRAPPER = [
  "for v in $(awk 'BEGIN { for (k in ENVIRON) print k }'); do",
  '  case " $1 " in *" $v "*) ;; *) unset "$v" ;; esac',
  "done",
  'shift; exec "$@"',
].join("\n");

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
      // Bounded in one shared place: Node calls these handlers directly, so a throw would reach
      // server.ts's uncaughtException guard and exit rather than this promise. See spawnCapture.ts.
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
   * - asRoot=true  → -u 0, in a fixed allowlisted env (ROOT_ENV, ROOT_INHERITED and `env`), cwd /
   * - cwd          → -w flag (default /workspace, or / as root)
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
    const { stdin, asRoot = false, cwd, trimStdout = false, env } = opts;
    const args = ["exec", "-i"];
    if (asRoot) {
      // A caller can add vars but never override the fixed ones.
      const rootEnv = { ...env, ...ROOT_ENV };
      const keep = [...Object.keys(rootEnv), ...ROOT_INHERITED].join(" ");
      args.push("-u", "0", ...envArgs(rootEnv), "-w", cwd ?? "/", containerName);
      args.push("/bin/sh", "-c", ROOT_WRAPPER, "root-exec", keep, ...cmdArgs);
    } else {
      args.push(...envArgs(env), "-w", cwd ?? "/workspace", containerName, ...cmdArgs);
    }
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
