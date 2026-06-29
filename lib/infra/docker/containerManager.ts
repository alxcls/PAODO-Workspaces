// Manages the Docker container lifecycle for each workspace.
// One container per workspace — started eagerly when an agent session begins, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Network naming:   wsnet_<workspaceId>  (isolated per-workspace bridge — no inter-container traffic)
// Bind mount:       <workspaceDir> → /workspace  (host files, shared with file tools)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS env vars (defaults: 1g / 1.0)
import { rm } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { getFreePort, cachePort, getCachedPort, invalidatePort, queryDockerPort } from "./portAllocator";
import path from "path";
import { createLogger } from "../logger";
import { DockerClient, IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import { composeAgentMounts, mountPolicyHash } from "./agentPermissionStore";
import type { IContainerManager } from "../interfaces";

export type { DockerResult } from "./dockerClient";

const log = createLogger("container");

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
// Label stamping the mount-affecting permission policy on the container, so a flip (deny-read/
// deny-edit change) is detected on the next `ensure` and triggers exactly one commit-preserving
// recreate. See agentPermissionStore.mountPolicyHash and the commit-on-flip handling below.
const PERMS_LABEL = "paodo.perms-hash";

// Hardening flags shared by the agent container and the one-shot privileged-script container: drop
// ALL caps, add back only the minimal set apt/dpkg + the chown sweep need under a root exec, and
// block setuid escalation. The agent's uid-1000 shell cannot reach these caps (no setuid path).
const CAP_ARGS = [
  "--cap-drop", "ALL",
  "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
  "--cap-add", "FSETID", "--cap-add", "SETGID", "--cap-add", "SETUID",
  "--security-opt", "no-new-privileges:true",
];
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

// Host interface the workspace server port is published on. Binding to a specific interface
// (rather than the default 0.0.0.0) keeps workspace dev servers off the public/tailnet interfaces
// so only the app can reach them — realizing the "never reachable from outside the host" intent.
//   - Local dev (app runs on the host): 127.0.0.1 — the proxy reaches it via localhost.
//   - Production (app runs in a container): the Docker bridge gateway the app already uses via
//     host.docker.internal, resolved once at runtime. If resolution fails we fall back to 0.0.0.0
//     (today's behavior) so a publish never breaks — hardening, never a functional regression.
let _bindHostCache: string | undefined;
async function resolveBindHost(): Promise<string> {
  if (process.env.WORKSPACE_BIND_HOST) return process.env.WORKSPACE_BIND_HOST;
  if (!WORKSPACES_VOLUME_NAME) return "127.0.0.1";
  if (_bindHostCache) return _bindHostCache;
  try {
    const { address } = await lookup("host.docker.internal");
    return (_bindHostCache = address);
  } catch {
    log.warn("could not resolve host.docker.internal — publishing workspace port on 0.0.0.0 (unhardened fallback)");
    return "0.0.0.0";
  }
}

export class ContainerManager implements IContainerManager {
  private docker: IDockerClient;
  private imageManager: ImageManager;
  constructor(docker: IDockerClient = new DockerClient()) {
    this.docker = docker;
    this.imageManager = new ImageManager(docker);
  }
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Prevents concurrent docker run/start calls for the same workspace.
  private startLocks = new Map<string, Promise<void>>();

  private containerName(workspaceId: string): string {
    return `ws_${workspaceId}`;
  }

  private networkName(workspaceId: string): string {
    return `wsnet_${workspaceId}`;
  }

  private async ensureNetwork(workspaceId: string): Promise<void> {
    const name = this.networkName(workspaceId);
    const inspect = await this.docker.cmd("network", "inspect", name);
    if (inspect.code === 0) return;
    const r = await this.docker.cmd("network", "create", "--driver", "bridge", name);
    if (r.code !== 0) throw new Error(`docker network create failed: ${r.stderr}`);
  }

  private resetIdleTimer(workspaceId: string): void {
    const existing = this.idleTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this.stop(workspaceId), IDLE_TIMEOUT_MS);
    t.unref();
    this.idleTimers.set(workspaceId, t);
  }

  private async getContainerStatus(workspaceId: string): Promise<"running" | "stopped" | "missing"> {
    const r = await this.docker.cmd("inspect", "--format", "{{.State.Status}}", this.containerName(workspaceId));
    if (r.code !== 0) return "missing";
    if (r.stdout === "running") return "running";
    return "stopped";
  }

  // Builds the volume args for docker run.
  // When WORKSPACES_VOLUME_NAME is set (production / Docker Compose), uses Docker 25+ volume
  // subpath mounting — necessary because the Docker daemon sees host paths, not app-container
  // paths, so a plain -v /app/data/<name>:/workspace would point at a non-existent host path.
  // When unset (local dev, app runs directly on host), falls back to a plain bind mount using
  // the resolved host path so local workspaces work without Docker Compose.
  private buildVolumeArg(workspaceDir: string): string[] {
    if (!WORKSPACES_VOLUME_NAME) {
      return ["-v", `${workspaceDir}:/workspace`];
    }
    const workspaceName = path.basename(workspaceDir);
    return [
      "--mount",
      `type=volume,source=${WORKSPACES_VOLUME_NAME},target=/workspace,volume-subpath=${workspaceName}`,
    ];
  }

  private snapshotImage(workspaceId: string): string {
    // Docker image refs must be lowercase; workspace ids already are, but be defensive.
    return `paodo-snapshot-${workspaceId.toLowerCase()}`;
  }

  private async snapshotExists(workspaceId: string): Promise<boolean> {
    const r = await this.docker.cmd("image", "inspect", this.snapshotImage(workspaceId));
    return r.code === 0;
  }

  /** Commit the live writable layer (apt/pip/home deps) to the per-workspace snapshot image so a
   *  flip recreate can restore it. Best-effort: on failure we log and fall back to the base image
   *  (deps rebuild) rather than block the flip. */
  private async commitSnapshot(workspaceId: string): Promise<void> {
    const r = await this.docker.cmd("commit", this.containerName(workspaceId), this.snapshotImage(workspaceId));
    if (r.code !== 0) log.warn({ workspaceId, stderr: r.stderr }, "commit-on-flip snapshot failed (deps will rebuild from base)");
    else log.debug({ workspaceId }, "committed snapshot for flip");
  }

  async removeSnapshot(workspaceId: string): Promise<void> {
    const r = await this.docker.cmd("rmi", "-f", this.snapshotImage(workspaceId));
    if (r.code !== 0) log.debug({ workspaceId, stderr: r.stderr }, "snapshot rmi (may not exist)");
  }

  // Reads an arbitrary label off a container, or null if absent/missing.
  private async getContainerLabel(workspaceId: string, label: string): Promise<string | null> {
    const r = await this.docker.cmd(
      "inspect", "--format", `{{index .Config.Labels "${label}"}}`, this.containerName(workspaceId),
    );
    return r.code === 0 ? r.stdout : null;
  }

  private async _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
    const status = await this.getContainerStatus(workspaceId);
    const hash = await this.imageManager.getCurrentHash("Dockerfile.workspace");
    const permsHash = mountPolicyHash(workspaceId);

    if (status === "running" || status === "stopped") {
      const containerHash = await this.imageManager.getContainerImageHash(this.containerName(workspaceId));
      const containerPerms = await this.getContainerLabel(workspaceId, PERMS_LABEL);
      const portMissing = (await this.getServerPort(workspaceId)) === null;
      const hashChanged = Boolean(hash) && containerHash !== hash;
      const permsChanged = (containerPerms ?? "none") !== permsHash;

      if (!hashChanged && !permsChanged && !portMissing) {
        if (status === "running") return;
        // unchanged, port mapped — just restart the stopped container
        log.debug({ workspaceId }, "starting stopped container");
        await this.ensureNetwork(workspaceId);
        const connect = await this.docker.cmd(
          "network", "connect", this.networkName(workspaceId), this.containerName(workspaceId),
        );
        if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
        const r = await this.docker.cmd("start", this.containerName(workspaceId));
        if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
        return;
      }

      if (hashChanged) {
        // Base image changed (platform update): discard the snapshot and rebuild deps from base.
        log.debug({ workspaceId }, "workspace image changed — recreating from base, discarding snapshot");
        await this.removeSnapshot(workspaceId);
      } else {
        // Flip (perms change) or a port-mapping repair: commit the writable layer first so the
        // recreate restores apt/pip/home deps (commit-on-flip). Only live processes/env are lost.
        log.debug({ workspaceId, permsChanged, portMissing }, "recreating container (commit-preserving)");
        await this.commitSnapshot(workspaceId);
      }
      await this.remove(workspaceId);
    }

    // missing (or just removed) — create and start. Run from the snapshot when one exists (deps
    // preserved across a flip); otherwise from the base image.
    const runImage = (await this.snapshotExists(workspaceId)) ? this.snapshotImage(workspaceId) : CONTAINER_IMAGE;
    log.debug({ workspaceId, runImage }, "creating container");
    await this.ensureNetwork(workspaceId);
    const serverPort = await getFreePort();
    const bindHost = await resolveBindHost();
    const r = await this.docker.cmd(
      "run", "-d",
      // --init runs tini as PID 1 so it reaps orphaned/killed processes. Without it, the keep-alive
      // `sleep infinity` is PID 1 and never wait()s on reparented children, so every command we
      // group-kill (execStreaming) would linger as a zombie and slowly exhaust the PID table.
      "--init",
      "--name", this.containerName(workspaceId),
      "--network", this.networkName(workspaceId),
      `--memory=${CONTAINER_MEMORY}`,
      `--cpus=${CONTAINER_CPUS}`,
      "-p", `${bindHost}:${serverPort}:8080`,
      ...this.buildVolumeArg(workspaceDir),
      // Agent file-restriction mounts composed from the permission store (deny-read stubs, deny-edit
      // :ro binds). These ARE the policy — kernel-enforced, not a tool check. Throws (fail-closed) on
      // a corrupt store or unresolvable path, aborting the run rather than starting unrestricted.
      ...composeAgentMounts(workspaceId, workspaceDir, Boolean(WORKSPACES_VOLUME_NAME)),
      ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
      "--label", `${PERMS_LABEL}=${permsHash}`,
      // Drop all Linux capabilities, then add back only the minimal set dpkg/apt and the chown sweep
      // need when run as root via `docker exec -u 0` (apt_install tool, ownership sweep). The agent's
      // shell is non-root with no setuid path, so it cannot use these caps — they are reachable only
      // by the app-initiated root execs. Combined with no-new-privileges this blocks setuid escalation.
      ...CAP_ARGS,
      runImage,
      "sleep", "infinity",
    );
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    cachePort(workspaceId, serverPort);

    // One-time ownership sweep: legacy workspaces created when the agent ran as root hold root-owned
    // files the uid-1000 agent/app can no longer manage. Chown the tree to 1000:1000 so both can.
    // Runs as root (-u 0) for this single bootstrap command only. Idempotent and cheap on
    // already-1000-owned trees.
    const chown = await this.docker.exec(
      this.containerName(workspaceId),
      ["chown", "-R", "1000:1000", "/workspace"],
      { asRoot: true, trimStdout: true },
    );
    if (chown.code !== 0)
      log.debug({ workspaceId, stderr: chown.stderr }, "workspace chown sweep failed (non-fatal)");
  }

  async ensure(workspaceId: string, workspaceDir: string): Promise<void> {
    // Coalesce concurrent calls: if a start is already in flight, piggyback on it.
    const inflight = this.startLocks.get(workspaceId);
    if (inflight) return inflight;

    const p = this._ensureContainer(workspaceId, workspaceDir).finally(() => {
      this.startLocks.delete(workspaceId);
      this.resetIdleTimer(workspaceId);
    });
    this.startLocks.set(workspaceId, p);
    return p;
  }

  /**
   * Run a non-streaming command inside the workspace container via docker exec.
   * Ensures the container is running first (idempotent, resets idle timer).
   * cmdArgs are passed directly to execvp — no shell interpolation, so injection is impossible.
   * stdout is NOT trimmed so callers receive exact file content (trailing newlines preserved).
   */
  async exec(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { stdin?: string } = {},
  ) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(this.containerName(workspaceId), cmdArgs, { stdin: opts.stdin });
  }

  async execStreaming(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void; signal?: AbortSignal },
  ): Promise<{ code: number | null }> {
    await this.ensure(workspaceId, workspaceDir);
    const containerName = this.containerName(workspaceId);
    return new Promise((resolve) => {
      // Run the command in its OWN session via setsid (so it becomes a process-group leader) and
      // record that leader PID. Killing the negative PID later (`kill -KILL -<pid>`) takes down the
      // command AND every child it spawned — the only reliable way to stop a runaway from outside
      // the container, since killing the host-side `docker exec` client just orphans it onto PID 1.
      // cmdArgs is a runnable argv (e.g. ["/bin/bash","-c",command]); `exec "$0" "$@"` re-execs it
      // in place, so the recorded PID is exactly the process that runs the work.
      const pidFile = `/tmp/paodo-exec-${randomUUID()}.pid`;
      const launcher = `echo $$ > ${pidFile}; exec "$0" "$@"`;
      // setsid --wait: create the new session (so the work is a killable process-group leader) but
      // BLOCK until it finishes and propagate its exit code. Without --wait, setsid forks and the
      // parent exits immediately, so the docker exec client closes at once — the command looks
      // instantly "done" and its output never streams.
      const proc = spawn("docker", [
        "exec", "-i", "-w", "/workspace", containerName,
        "setsid", "--wait", "/bin/bash", "-c", launcher, ...cmdArgs,
      ]);
      proc.stdin.end();
      proc.stdout.on("data", (chunk: Buffer) => opts.onStdout(chunk.toString()));
      proc.stderr.on("data", (chunk: Buffer) => opts.onStderr(chunk.toString()));

      let killed = false;
      const kill = () => {
        if (killed) return;
        killed = true;
        // Fire-and-forget: kill the in-container process group, then drop the host-side client.
        this.docker
          .exec(containerName, ["/bin/bash", "-c", `kill -KILL -"$(cat ${pidFile} 2>/dev/null)" 2>/dev/null; rm -f ${pidFile}`])
          .catch(() => {});
        proc.kill("SIGKILL");
      };

      if (opts.signal) {
        if (opts.signal.aborted) kill();
        else opts.signal.addEventListener("abort", kill, { once: true });
      }

      const done = (code: number | null) => {
        opts.signal?.removeEventListener("abort", kill);
        resolve({ code });
      };
      proc.on("close", (code) => done(code));
      proc.on("error", () => done(1));
    });
  }

  // Runs a command inside the workspace container AS ROOT (-u 0). This is the single sanctioned root
  // exec path for agent-facing functionality — used only by the `apt_install` tool to install system
  // packages. cmdArgs are passed as argv (no shell), so callers must still validate untrusted input.
  // The regular agent shell (exec / execute_command) never runs as root.
  async execAsRoot(workspaceId: string, workspaceDir: string, cmdArgs: string[]) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(this.containerName(workspaceId), cmdArgs, {
      asRoot: true,
      trimStdout: true,
    });
  }

  /**
   * Run a registered privileged script in a ONE-SHOT container that mounts the workspace WITHOUT the
   * restriction topology — "privilege by location". The script therefore sees deny-read content and
   * can write deny-edit paths, while the agent that triggered it (whose own container keeps the
   * restriction mounts) gains nothing. Hardened identically (uid 1000, cap set, no-new-privileges)
   * and network-isolated, so the script is sandboxed exactly like the agent minus the restrictions.
   * Fixed argv: only the script path runs — no agent-supplied args, no shell-interpolated input.
   */
  async runPrivilegedScript(
    workspaceId: string,
    workspaceDir: string,
    scriptRelpath: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    // Ensure the agent container's writable layer is committed first, so the script runs against the
    // same deps the agent has (apt/pip). Cheap no-op when no snapshot/commit is possible.
    if (await this.snapshotExists(workspaceId)) await this.commitSnapshot(workspaceId);
    const runImage = (await this.snapshotExists(workspaceId)) ? this.snapshotImage(workspaceId) : CONTAINER_IMAGE;
    const r = await this.docker.cmd(
      "run", "--rm", "-u", "1000:1000",
      "--network", "none", // a privileged script handles unrestricted files; deny it egress.
      ...CAP_ARGS,
      ...this.buildVolumeArg(workspaceDir), // base mount only — NO composeAgentMounts restrictions.
      "-w", "/workspace",
      runImage,
      // No shell wrapping of untrusted input: bash executes exactly the one registered path.
      "bash", `/workspace/${scriptRelpath}`,
    );
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  async stop(workspaceId: string): Promise<void> {
    const t = this.idleTimers.get(workspaceId);
    if (t) { clearTimeout(t); this.idleTimers.delete(workspaceId); }
    const r = await this.docker.cmd("stop", this.containerName(workspaceId));
    if (r.code !== 0) log.warn({ workspaceId, stderr: r.stderr }, "docker stop failed");
    await this.docker.cmd("network", "disconnect", this.networkName(workspaceId), this.containerName(workspaceId));
    const net = await this.docker.cmd("network", "rm", this.networkName(workspaceId));
    if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "network rm on stop (may not exist)");
  }

  async remove(workspaceId: string): Promise<void> {
    const t = this.idleTimers.get(workspaceId);
    if (t) { clearTimeout(t); this.idleTimers.delete(workspaceId); }
    this.startLocks.delete(workspaceId);
    invalidatePort(workspaceId);
    // Non-zero exit codes are expected if the container/network was never created.
    const stop = await this.docker.cmd("stop", this.containerName(workspaceId));
    if (stop.code !== 0) log.debug({ workspaceId, stderr: stop.stderr }, "docker stop on remove (may not exist)");
    const rm = await this.docker.cmd("rm", this.containerName(workspaceId));
    if (rm.code !== 0) log.debug({ workspaceId, stderr: rm.stderr }, "docker rm on remove (may not exist)");
    const net = await this.docker.cmd("network", "rm", this.networkName(workspaceId));
    if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "docker network rm on remove (may not exist)");
  }

  /** Returns the host port mapped to container port 8080, or null if no mapping exists. */
  async getServerPort(workspaceId: string): Promise<number | null> {
    const cached = getCachedPort(workspaceId);
    if (cached !== undefined) return cached;
    const port = await queryDockerPort(this.containerName(workspaceId), this.docker);
    if (port !== null) cachePort(workspaceId, port);
    return port;
  }

  // Deletes a workspace directory from the volume. In production (WORKSPACES_VOLUME_NAME set) it
  // mounts the full volume and removes the subdir as root (-u 0) — the agent now runs as uid 1000 so
  // its files are normally removable directly, but a throwaway root rm also clears any legacy
  // root-owned files left by workspaces created before the non-root migration.
  // In local dev falls back to a plain fs.rm since the app runs as the host user.
  async deleteWorkspaceDir(workspaceDir: string): Promise<void> {
    if (WORKSPACES_VOLUME_NAME) {
      const workspaceName = path.basename(workspaceDir);
      const r = await this.docker.cmd(
        "run", "--rm", "-u", "0",
        "-v", `${WORKSPACES_VOLUME_NAME}:/data`,
        CONTAINER_IMAGE, "rm", "-rf", `/data/${workspaceName}`,
      );
      if (r.code !== 0) throw new Error(`failed to delete workspace dir: ${r.stderr}`);
    } else {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  async assertDockerAvailable(): Promise<void> {
    const r = await this.docker.cmd("info");
    if (r.code !== 0) {
      log.error({ stderr: r.stderr }, "Docker is not available. Make sure Docker is running before starting the server.");
      process.exit(1);
    }
    await this.imageManager.ensureImage(CONTAINER_IMAGE, "Dockerfile.workspace");
  }
}

// Singleton — module-level state intentionally lives here (not on `global`) because Next.js
// hot-reload doesn't re-import server-side-only infra modules through the app bundle.
const _manager = new ContainerManager();

// Exposed for lib/infra/services.ts (the default IContainerManager). Free-function exports below
// remain the back-compat call path.
export const defaultContainerManager = _manager;

export const ensureContainer        = (id: string, dir: string)                                        => _manager.ensure(id, dir);
export const dockerExec             = (id: string, dir: string, cmd: string[], opts?: { stdin?: string }) => _manager.exec(id, dir, cmd, opts);
export const dockerExecAsRoot       = (id: string, dir: string, cmd: string[])                         => _manager.execAsRoot(id, dir, cmd);
export const dockerExecStreaming    = (id: string, dir: string, cmd: string[], opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void }) => _manager.execStreaming(id, dir, cmd, opts);
export const stopContainer          = (id: string)                                                      => _manager.stop(id);
export const removeContainer        = (id: string)                                                      => _manager.remove(id);
export const getContainerServerPort = (id: string)                                                      => _manager.getServerPort(id);
export const deleteWorkspaceDir     = (dir: string)                                                     => _manager.deleteWorkspaceDir(dir);
export const assertDockerAvailable  = ()                                                                => _manager.assertDockerAvailable();
