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
import { randomUUID, createHash } from "crypto";
import path from "path";
import { createLogger } from "../logger";
import { DockerClient, IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import type { IContainerManager } from "../interfaces";
import { listSecretMeta, PROXY_TOKEN_FORMAT_VERSION } from "../security/workspaceSecretStore";
import { buildCredentialEnv, installProxyCA } from "./containerCredentials";
import { containerName, networkName } from "./naming";
import { BackgroundTaskManager, type BackgroundTask } from "./backgroundTaskManager";
import { ProxyNetworkManager } from "./proxyNetworkManager";

// Re-exported for back-compat: consumers (interfaces.ts) still import BackgroundTask from here.
export type { BackgroundTask } from "./backgroundTaskManager";

const log = createLogger("container");

// Label recording which secrets were baked into the container's env at creation time (as a
// hash of their sorted names plus the proxy-token format — token values are derived from
// name+workspaceId alone, so this detects additions/removals and forces a safe recreation when the
// opaque token format changes; domain-only changes don't affect env args).
const SECRETS_LABEL = "paodo.workspace-secrets-hash";

function hashSecretNames(secrets: { name: string }[]): string {
  const sorted = secrets.map((s) => s.name).sort();
  return createHash("sha256")
    .update(`${PROXY_TOKEN_FORMAT_VERSION}\0${sorted.join(",")}`)
    .digest("hex");
}

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

export class ContainerManager implements IContainerManager {
  private docker: IDockerClient;
  private imageManager: ImageManager;
  // Long-lived background processes the agent launched (dev servers etc.) and the credential-proxy
  // sidecar networking are each their own collaborator — this class owns only container/network
  // lifecycle and exec, and delegates those two subdomains. Both share our injected docker client.
  private background: BackgroundTaskManager;
  private proxy: ProxyNetworkManager;
  constructor(docker: IDockerClient = new DockerClient()) {
    this.docker = docker;
    this.imageManager = new ImageManager(docker);
    this.background = new BackgroundTaskManager(docker);
    this.proxy = new ProxyNetworkManager(docker);
  }
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Prevents concurrent docker run/start calls for the same workspace.
  private startLocks = new Map<string, Promise<void>>();

  private async ensureNetwork(workspaceId: string): Promise<void> {
    const name = networkName(workspaceId);
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
    const r = await this.docker.cmd("inspect", "--format", "{{.State.Status}}", containerName(workspaceId));
    if (r.code !== 0) return "missing";
    if (r.stdout === "running") return "running";
    return "stopped";
  }

  // Returns the secrets-hash label from an existing container, or null if not present.
  private async getContainerSecretsHash(containerName: string): Promise<string | null> {
    const r = await this.docker.cmd(
      "inspect",
      "--format",
      `{{index .Config.Labels "${SECRETS_LABEL}"}}`,
      containerName,
    );
    return r.code === 0 ? r.stdout : null;
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

  private async _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
    const status = await this.getContainerStatus(workspaceId);
    const hash = await this.imageManager.getCurrentHash("Dockerfile.workspace");
    const secretsHash = hashSecretNames(listSecretMeta(workspaceId));

    if (status === "running" || status === "stopped") {
      const containerHash = await this.imageManager.getContainerImageHash(containerName(workspaceId));
      const containerSecretsHash = await this.getContainerSecretsHash(containerName(workspaceId));
      const imageMatches = !hash || containerHash === hash;
      const secretsMatch = containerSecretsHash === secretsHash;
      if (imageMatches && secretsMatch) {
        if (status === "running") {
          // Reattaching to a still-running container (e.g. after an app restart wiped our
          // in-memory task map). Rebuild it from the container's pidfiles so a survivor
          // background process is surfaced and stoppable rather than colliding invisibly.
          await this.background.rehydrate(workspaceId);
          // A redeploy can recreate the credproxy sidecar and drop its attachment to this
          // still-running workspace's network, black-holing egress. Reattach idempotently.
          await this.proxy.attach(workspaceId);
          return;
        }
        // Stopped, image unchanged, secrets unchanged — just restart it.
        log.debug({ workspaceId }, "starting stopped container");
        await this.ensureNetwork(workspaceId);
        const connect = await this.docker.cmd(
          "network",
          "connect",
          networkName(workspaceId),
          containerName(workspaceId),
        );
        if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
        const r = await this.docker.cmd("start", containerName(workspaceId));
        if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
        await this.proxy.attach(workspaceId);
        return;
      } else if (!secretsMatch) {
        // Workspace secrets were added/removed since this container was created (or it
        // predates the secrets-hash label) — recreate so env vars reflect the current set.
        log.debug({ workspaceId }, "workspace secrets changed — recreating container");
      } else {
        // Image changed — remove so we recreate from the current image below.
        log.debug({ workspaceId }, "workspace image changed — recreating container");
      }
      await this.remove(workspaceId);
    }

    // missing (or just removed) — create and start
    log.debug({ workspaceId }, "creating container");
    await this.ensureNetwork(workspaceId);

    // Build the credential-proxy + secret env args (tokens only — real values stay in the proxy).
    // See containerCredentials.ts for how tokens, the proxy URL, and the CA-trust vars are derived.
    const { envArgs: credentialEnvArgs, hasProxyCA } = buildCredentialEnv(workspaceId);
    // Attach the sidecar to this workspace's network so the proxy alias resolves inside the
    // container. Only when this workspace actually has a proxy CA; attach() itself no-ops in local
    // dev (no sidecar — proxy is in-process).
    if (hasProxyCA) await this.proxy.attach(workspaceId);

    const r = await this.docker.cmd(
      "run",
      "-d",
      // --init runs tini as PID 1 so it reaps orphaned/killed processes. Without it, the keep-alive
      // `sleep infinity` is PID 1 and never wait()s on reparented children, so every command we
      // group-kill (execStreaming) would linger as a zombie and slowly exhaust the PID table.
      "--init",
      "--name",
      containerName(workspaceId),
      "--network",
      networkName(workspaceId),
      `--memory=${CONTAINER_MEMORY}`,
      `--cpus=${CONTAINER_CPUS}`,
      ...this.buildVolumeArg(workspaceDir),
      ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
      "--label",
      `${SECRETS_LABEL}=${secretsHash}`,
      ...credentialEnvArgs,
      // Drop all Linux capabilities, then add back only the minimal set dpkg/apt and the chown sweep
      // need when run as root via `docker exec -u 0` (apt_install tool, ownership sweep). The agent's
      // shell is non-root with no setuid path, so it cannot use these caps — they are reachable only
      // by the app-initiated root execs. Combined with no-new-privileges this blocks setuid escalation.
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "FSETID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:true",
      CONTAINER_IMAGE,
      "sleep",
      "infinity",
    );
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);

    // One-time ownership sweep: legacy workspaces created when the agent ran as root hold root-owned
    // files the uid-1000 agent/app can no longer manage. Chown the tree to 1000:1000 so both can.
    // Runs as root (-u 0) for this single bootstrap command only. Idempotent and cheap on
    // already-1000-owned trees.
    const chown = await this.docker.exec(containerName(workspaceId), ["chown", "-R", "1000:1000", "/workspace"], {
      asRoot: true,
      trimStdout: true,
    });
    if (chown.code !== 0) log.debug({ workspaceId, stderr: chown.stderr }, "workspace chown sweep failed (non-fatal)");

    // Install the proxy CA and build the combined trust bundle inside the fresh container (no-op
    // when the proxy isn't set up). See containerCredentials.installProxyCA.
    await installProxyCA(this.docker, containerName(workspaceId), workspaceId);
  }

  async ensure(workspaceId: string, workspaceDir: string): Promise<void> {
    // Coalesce concurrent calls: if a start is already in flight, piggyback on it.
    const inflight = this.startLocks.get(workspaceId);
    if (inflight) return inflight;

    const p = (async () => {
      await this._ensureContainer(workspaceId, workspaceDir);
      // Enforce the egress invariant on every wake: the credproxy sidecar must be attached to this
      // workspace's network. Self-heals a dropped attachment and fails loudly if it can't, rather
      // than letting the agent black-hole on cryptic "could not resolve proxy" DNS errors.
      await this.proxy.verify(workspaceId);
    })().finally(() => {
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
  async exec(workspaceId: string, workspaceDir: string, cmdArgs: string[], opts: { stdin?: string } = {}) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(containerName(workspaceId), cmdArgs, { stdin: opts.stdin });
  }

  async execStreaming(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void; signal?: AbortSignal },
  ): Promise<{ code: number | null }> {
    await this.ensure(workspaceId, workspaceDir);
    const name = containerName(workspaceId);
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
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("docker", [
          "exec",
          "-i",
          "-w",
          "/workspace",
          name,
          "setsid",
          "--wait",
          "/bin/bash",
          "-c",
          launcher,
          ...cmdArgs,
        ]);
      } catch (err) {
        log.error({ err, workspaceId }, "failed to spawn Docker foreground command");
        opts.onStderr(`${err instanceof Error ? err.message : String(err)}\n`);
        resolve({ code: 1 });
        return;
      }
      proc.stdin!.end();
      proc.stdout!.on("data", (chunk: Buffer) => opts.onStdout(chunk.toString()));
      proc.stderr!.on("data", (chunk: Buffer) => opts.onStderr(chunk.toString()));

      let killed = false;
      const kill = () => {
        if (killed) return;
        killed = true;
        // Fire-and-forget: kill the in-container process group, then drop the host-side client.
        this.docker
          .exec(name, ["/bin/bash", "-c", `kill -KILL -"$(cat ${pidFile} 2>/dev/null)" 2>/dev/null; rm -f ${pidFile}`])
          .catch((err) => log.warn({ err, workspaceId }, "failed to kill aborted foreground command inside container"));
        proc.kill("SIGKILL");
      };

      if (opts.signal) {
        if (opts.signal.aborted) kill();
        else opts.signal.addEventListener("abort", kill, { once: true });
      }

      let finished = false;
      const done = (code: number | null) => {
        if (finished) return;
        finished = true;
        opts.signal?.removeEventListener("abort", kill);
        resolve({ code });
      };
      proc.on("close", (code) => done(code));
      proc.on("error", (err) => {
        log.error({ err, workspaceId }, "Docker foreground command process error");
        done(1);
      });
    });
  }

  // Runs a command inside the workspace container AS ROOT (-u 0). This is the single sanctioned root
  // exec path for agent-facing functionality — used only by the `apt_install` tool to install system
  // packages. cmdArgs are passed as argv (no shell), so callers must still validate untrusted input.
  // The regular agent shell (exec / execute_command) never runs as root.
  async execAsRoot(workspaceId: string, workspaceDir: string, cmdArgs: string[]) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(containerName(workspaceId), cmdArgs, {
      asRoot: true,
      trimStdout: true,
    });
  }

  // Detached, long-lived background processes (dev servers etc.) — delegated to BackgroundTaskManager.
  // ensure() runs first so the container is up before the collaborator issues its in-container launch.
  async startBackground(
    workspaceId: string,
    workspaceDir: string,
    command: string,
  ): Promise<{ taskId: string; logFile: string }> {
    await this.ensure(workspaceId, workspaceDir);
    return this.background.start(workspaceId, command);
  }

  async stopBackground(workspaceId: string, taskId: string): Promise<boolean> {
    return this.background.stop(workspaceId, taskId);
  }

  listBackground(workspaceId: string): BackgroundTask[] {
    return this.background.list(workspaceId);
  }

  // On boot, reconnect the credproxy sidecar to every running workspace network (prod-only).
  async reattachProxyNetworks(): Promise<void> {
    await this.proxy.reattachAll();
  }

  async stop(workspaceId: string): Promise<void> {
    const t = this.idleTimers.get(workspaceId);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(workspaceId);
    }
    // Background processes die with the container (tini reaps the tree) — just drop the bookkeeping.
    this.background.clear(workspaceId);
    const r = await this.docker.cmd("stop", containerName(workspaceId));
    if (r.code !== 0) log.warn({ workspaceId, stderr: r.stderr }, "docker stop failed");
    await this.docker.cmd("network", "disconnect", networkName(workspaceId), containerName(workspaceId));
    await this.proxy.detach(workspaceId);
    const net = await this.docker.cmd("network", "rm", networkName(workspaceId));
    if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "network rm on stop (may not exist)");
  }

  async remove(workspaceId: string): Promise<void> {
    const t = this.idleTimers.get(workspaceId);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(workspaceId);
    }
    this.startLocks.delete(workspaceId);
    this.background.clear(workspaceId);
    // Non-zero exit codes are expected if the container/network was never created.
    const stop = await this.docker.cmd("stop", containerName(workspaceId));
    if (stop.code !== 0) log.debug({ workspaceId, stderr: stop.stderr }, "docker stop on remove (may not exist)");
    const rm = await this.docker.cmd("rm", containerName(workspaceId));
    if (rm.code !== 0) log.debug({ workspaceId, stderr: rm.stderr }, "docker rm on remove (may not exist)");
    await this.proxy.detach(workspaceId);
    const net = await this.docker.cmd("network", "rm", networkName(workspaceId));
    if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "docker network rm on remove (may not exist)");
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
        "run",
        "--rm",
        "-u",
        "0",
        "-v",
        `${WORKSPACES_VOLUME_NAME}:/data`,
        CONTAINER_IMAGE,
        "rm",
        "-rf",
        `/data/${workspaceName}`,
      );
      if (r.code !== 0) throw new Error(`failed to delete workspace dir: ${r.stderr}`);
    } else {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  async assertDockerAvailable(): Promise<void> {
    const r = await this.docker.cmd("info");
    if (r.code !== 0) {
      log.error(
        { stderr: r.stderr },
        "Docker is not available. Make sure Docker is running before starting the server.",
      );
      process.exit(1);
    }
    await this.imageManager.ensureImage(CONTAINER_IMAGE, "Dockerfile.workspace");
  }
}

// Singleton — module-level state intentionally lives here (not on `global`) because Next.js
// hot-reload doesn't re-import server-side-only infra modules through the app bundle.
const _manager = new ContainerManager();

// Exposed for lib/infra/services.ts as the default IContainerManager. Consumers call through this
// instance (or the getContainers() DI seam); there is no separate free-function call path.
export const defaultContainerManager = _manager;
