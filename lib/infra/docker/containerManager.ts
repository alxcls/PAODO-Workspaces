// Manages the Docker container lifecycle for each workspace.
// One container per workspace — started eagerly when an agent session begins, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Network naming:   wsnet_<workspaceId>  (isolated per-workspace bridge — no inter-container traffic)
// Bind mount:       <workspaceDir> → /workspace  (host files, shared with file tools)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS / CONTAINER_PIDS_LIMIT env vars
//                   (defaults: 1g / 1.0 / 512)
import { rm } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { createLogger, exitAfterLogs } from "../logger";
import { envArgs, type IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import type { IContainerManager } from "../interfaces";
import { containerName, networkName } from "./naming";
import { BackgroundTaskManager, type BackgroundTask } from "./backgroundTaskManager";
import { ProxyNetworkManager } from "./proxyNetworkManager";

// Re-exported for back-compat with external consumers.
export type { BackgroundTask } from "./backgroundTaskManager";

const log = createLogger("container");

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
// Max processes+threads in the container's pid cgroup. Docker's default is unlimited, which lets a
// fork bomb (or a runaway spawn loop) in ANY workspace exhaust the host's global pid_max — at which
// point nothing on the host can fork, including the `docker exec` this app spawns per command. The
// memory cap is not a backstop: a forking cgroup under memory pressure thrashes the OOM killer
// rather than stopping. Threads count too, so anything thread-heavy (JVM, browser grids, `make -j`)
// needs this raised. Hitting the cap surfaces as "Resource temporarily unavailable" on fork.
const CONTAINER_PIDS = process.env.CONTAINER_PIDS_LIMIT ?? "512";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

/** Workspace policy and credential material needed by the Docker lifecycle. The concrete
 * workspace/secret stores are wired only by defaultContainerManager.ts. */
export interface ContainerWorkspaceDependencies {
  internetAccessFor(workspaceId: string): boolean;
  /**
   * Env baked in at `docker run`: proxy routing and CA trust. Depends only on the workspace id and
   * whether the proxy CA exists, so it never changes for a given workspace — which is what lets the
   * container live indefinitely without its env going stale.
   */
  runEnvironment(workspaceId: string): { envArgs: string[]; hasProxyCA: boolean };
  /**
   * Secret tokens supplied fresh on every `docker exec`. Kept out of `docker run` because Docker
   * cannot amend a container's env after creation, and this container is never recreated — so
   * baking secrets in would freeze them at whatever the workspace had on its first ever command.
   */
  execEnvironment(workspaceId: string, internetAccess: boolean): Record<string, string>;
  installProxyCA(docker: IDockerClient, containerName: string, workspaceId: string): Promise<void>;
}

// Safe standalone default for isolated unit tests and explicit custom composition. Production
// always supplies the real adapter from defaultContainerManager.ts.
const isolatedWorkspaceDependencies: ContainerWorkspaceDependencies = {
  internetAccessFor: () => false,
  runEnvironment: () => ({ envArgs: [], hasProxyCA: false }),
  execEnvironment: () => ({}),
  installProxyCA: async () => {},
};

export class ContainerManager implements IContainerManager {
  private docker: IDockerClient;
  private imageManager: ImageManager;
  // Long-lived background processes the agent launched (dev servers etc.) and the credential-proxy
  // sidecar networking are each their own collaborator — this class owns only container/network
  // lifecycle and exec, and delegates those two subdomains. Both share our injected docker client.
  private background: BackgroundTaskManager;
  private proxy: ProxyNetworkManager;
  constructor(
    docker: IDockerClient,
    private readonly workspaceDeps: ContainerWorkspaceDependencies = isolatedWorkspaceDependencies,
  ) {
    this.docker = docker;
    this.imageManager = new ImageManager(docker);
    this.background = new BackgroundTaskManager(docker);
    this.proxy = new ProxyNetworkManager(docker);
  }
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Prevents concurrent docker run/start/stop calls for the same workspace. Tagged by kind so
  // ensure() can still coalesce concurrent ensure() calls onto one shared promise (same desired
  // outcome), while a stop() in flight is never handed out that way — its promise resolves to
  // "stopped," not "ready," so a concurrent ensure() must wait it out and then run its own fresh
  // pass instead of piggybacking on it. See ensure()/stop() below.
  private startLocks = new Map<string, { kind: "ensure" | "stop"; promise: Promise<void> }>();

  // Creates the workspace's isolated network, or recreates it if its --internal flag doesn't match
  // the workspace's current internetAccess setting. Docker can't flip --internal on an existing
  // network, so a mismatch (e.g. a network that survived an unclean exit before a toggle, or one
  // created under the old policy) is deleted and recreated rather than left stale — leaving it stale
  // would silently keep an "off" workspace on a network with a real route out, or vice versa.
  private async ensureNetwork(workspaceId: string, internetAccess: boolean): Promise<void> {
    const name = networkName(workspaceId);
    const inspect = await this.docker.cmd("network", "inspect", name, "--format", "{{.Internal}}");
    if (inspect.code === 0) {
      const isInternal = inspect.stdout.trim() === "true";
      if (isInternal === !internetAccess) return;
      log.debug({ workspaceId, isInternal, internetAccess }, "network internet-access flag mismatch — recreating");
      // A container (or the credproxy sidecar) that reached this state without going through our own
      // stop() (unclean exit, manual `docker stop`, daemon restart) can still hold an endpoint on
      // this network even while stopped — network rm fails with "has active endpoints" until every
      // endpoint is disconnected. Force both loose first; the clean case with nothing attached just
      // no-ops on each.
      await this.docker.cmd("network", "disconnect", "-f", name, containerName(workspaceId));
      await this.proxy.detach(workspaceId);
      const rm = await this.docker.cmd("network", "rm", name);
      if (rm.code !== 0) throw new Error(`docker network rm failed while recreating with new policy: ${rm.stderr}`);
    }
    const args = ["network", "create", "--driver", "bridge"];
    if (!internetAccess) args.push("--internal");
    args.push(name);
    const r = await this.docker.cmd(...args);
    if (r.code !== 0) throw new Error(`docker network create failed: ${r.stderr}`);
  }

  // Bring the workspace's network, and the container's membership of it, in line with the current
  // policy. Run on every wake rather than only at create/start, because the container now outlives
  // every network operation performed around it and can be left behind by one:
  //   - applyInternetAccess rebuilds the network under a running container. If the rebuild fails
  //     partway (create or connect), the container is left holding no network at all and nothing
  //     else would ever rejoin it — the workspace would be silently offline until it idled out.
  //   - a rolled-back toggle can leave the network's --internal flag disagreeing with the policy
  //     the registry ended up persisting.
  // ensureNetwork already no-ops when the flag matches, so the healthy case costs one inspect.
  private async reconcileNetwork(workspaceId: string, internetAccess: boolean): Promise<void> {
    await this.ensureNetwork(workspaceId, internetAccess);
    const connect = await this.docker.cmd("network", "connect", networkName(workspaceId), containerName(workspaceId));
    // Already attached is success, not failure — this runs on every wake, so a healthy container is
    // the common case, not a fresh attachment.
    if (connect.code !== 0 && !/already (exists|connected)/i.test(connect.stderr)) {
      throw new Error(`docker network connect failed: ${connect.stderr}`);
    }
    // A redeploy can recreate the credproxy sidecar and drop its attachment to a still-running
    // workspace's network, black-holing egress. Reattach idempotently — but only when this
    // workspace should have egress at all; an off workspace's network was never internet-reachable
    // in the first place, so there is nothing to reattach.
    if (internetAccess) await this.proxy.attach(workspaceId);
  }

  private resetIdleTimer(workspaceId: string): void {
    const existing = this.idleTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      void this.stop(workspaceId).catch((err) => {
        log.warn({ err, workspaceId }, "idle container stop failed");
      });
    }, IDLE_TIMEOUT_MS);
    t.unref();
    this.idleTimers.set(workspaceId, t);
  }

  // Secret env for a single command. Recomputed per exec rather than cached, so adding or revoking
  // a secret takes effect on the very next command with no container churn. Cheap: the secret store
  // is in memory and the tokens are derived, so this never touches disk.
  private execEnv(workspaceId: string): Record<string, string> {
    return this.workspaceDeps.execEnvironment(workspaceId, this.workspaceDeps.internetAccessFor(workspaceId));
  }

  private async getContainerStatus(workspaceId: string): Promise<"running" | "stopped" | "missing"> {
    const r = await this.docker.cmd("inspect", "--format", "{{.State.Status}}", containerName(workspaceId));
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

  private async _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
    let stage = "inspect_container";
    // Fails closed (no internet) if the workspace record can't be found at all — only a record
    // that exists but predates this field defaults to true (see workspaceStore.ts hydration).
    // Read once so the network-create and proxy-attach decisions below can't disagree with each
    // other partway through this method.
    const internetAccess = this.workspaceDeps.internetAccessFor(workspaceId);
    try {
      const status = await this.getContainerStatus(workspaceId);

      // An existing container is ALWAYS reused as-is — never torn down and rebuilt. Its writable
      // layer holds everything the agent installed (apt packages, pip/npm modules, nvm/pyenv
      // runtimes), which is the workspace's real content; the image is only where it started. A
      // container that drifts from the image is therefore working as intended, not stale.
      if (status === "running") {
        // Reattaching to a still-running container (e.g. after an app restart wiped our
        // in-memory task map). Rebuild it from the container's pidfiles so a survivor
        // background process is surfaced and stoppable rather than colliding invisibly.
        stage = "rehydrate_background_tasks";
        await this.background.rehydrate(workspaceId);
        stage = "reconcile_network";
        await this.reconcileNetwork(workspaceId, internetAccess);
        return;
      }

      if (status === "stopped") {
        // Restart in place. `docker start` preserves the writable layer, so everything installed
        // in a previous session is still there — only `docker rm` would lose it.
        log.debug({ workspaceId }, "starting stopped container");
        stage = "reconcile_network";
        await this.reconcileNetwork(workspaceId, internetAccess);
        stage = "start_container";
        const r = await this.docker.cmd("start", containerName(workspaceId));
        if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
        return;
      }

      // missing — first run for this workspace, so create and start
      log.debug({ workspaceId }, "creating container");
      stage = "ensure_network";
      await this.ensureNetwork(workspaceId, internetAccess);
      stage = "hash_workspace_image";
      // Only the create path uses this — it is recorded as a label on the new container. Computed
      // here rather than before the branches above so a reused container never pays to read and
      // hash the Dockerfile on every single command.
      const hash = await this.imageManager.getCurrentHash("Dockerfile.workspace");

      // Build the credential-proxy routing + CA-trust env. Secrets are NOT here — they are injected
      // per exec (see execEnvironment), because this container is never recreated and Docker cannot
      // amend a container's env after creation. See containerCredentials.ts.
      stage = "build_credential_environment";
      const { envArgs: runEnvArgs, hasProxyCA } = this.workspaceDeps.runEnvironment(workspaceId);
      // Attach the sidecar to this workspace's network so the proxy alias resolves inside the
      // container. Only when this workspace actually has a proxy CA (attach() itself no-ops in
      // local dev — no sidecar, proxy is in-process) AND internet access is on — an off workspace's
      // network has no route out at all, so there is nothing for the sidecar to usefully reach here.
      if (hasProxyCA && internetAccess) {
        stage = "attach_credential_proxy";
        await this.proxy.attach(workspaceId);
      }

      stage = "run_container";
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
        `--pids-limit=${CONTAINER_PIDS}`,
        ...this.buildVolumeArg(workspaceDir),
        // Recorded for diagnostics only — which base image this container was born from. Nothing
        // acts on it: a newer image never triggers a rebuild, because that would discard everything
        // the agent has installed since. New images apply to newly created workspaces.
        ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
        ...runEnvArgs,
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
      stage = "repair_workspace_ownership";
      const chown = await this.docker.exec(containerName(workspaceId), ["chown", "-R", "1000:1000", "/workspace"], {
        asRoot: true,
        trimStdout: true,
      });
      if (chown.code !== 0) {
        log.warn(
          {
            event: "workspace_ownership_repair_failed",
            outcome: "workspace_permissions_may_be_incorrect",
            workspaceId,
            stderr: chown.stderr,
          },
          "workspace ownership repair failed",
        );
      }

      // Install the proxy CA and build the combined trust bundle inside the fresh container (no-op
      // when the proxy isn't set up). See containerCredentials.installProxyCA.
      stage = "install_proxy_ca";
      await this.workspaceDeps.installProxyCA(this.docker, containerName(workspaceId), workspaceId);
    } catch (err) {
      log.error(
        {
          event: "workspace_container_start_failed",
          outcome: "workspace_container_unavailable",
          err,
          workspaceId,
          stage,
        },
        "workspace container failed to start",
      );
      throw err;
    }
  }

  async ensure(workspaceId: string, workspaceDir: string): Promise<void> {
    // Coalesce concurrent ensure() calls onto one in-flight promise. But a concurrent stop() (e.g.
    // the internet-access toggle route) is never piggybacked on — its promise resolves to
    // "stopped," which is the opposite of what an ensure() caller wants — so wait it out and then
    // run our own fresh ensure. The check-then-set below has no `await` in between, so nothing else
    // can claim the slot while we're mid-loop.
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      if (inflight.kind === "ensure") return inflight.promise;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      await this._ensureContainer(workspaceId, workspaceDir);
      // Enforce the egress invariant on every wake: the credproxy sidecar must be attached to this
      // workspace's network. Self-heals a dropped attachment and fails loudly if it can't, rather
      // than letting the agent black-hole on cryptic "could not resolve proxy" DNS errors. Skipped
      // entirely for an off workspace — verify()'s whole purpose is to *reattach* a dropped
      // connection, which would silently undo the isolation an off workspace depends on. Fails
      // closed (skips reattach) if the workspace record can't be found at all.
      const internetAccess = this.workspaceDeps.internetAccessFor(workspaceId);
      if (internetAccess) {
        try {
          await this.proxy.verify(workspaceId);
        } catch (err) {
          log.error(
            {
              event: "workspace_container_start_failed",
              outcome: "workspace_container_unavailable",
              err,
              workspaceId,
              stage: "verify_proxy_network",
            },
            "workspace container failed to start",
          );
          throw err;
        }
      }
    })().finally(() => {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
      this.resetIdleTimer(workspaceId);
    });
    this.startLocks.set(workspaceId, { kind: "ensure", promise: p });
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
    opts: { stdin?: import("./dockerClient").DockerStdin } = {},
  ) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(containerName(workspaceId), cmdArgs, {
      stdin: opts.stdin,
      env: this.execEnv(workspaceId),
    });
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
          ...envArgs(this.execEnv(workspaceId)),
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
        log.error(
          { event: "docker_foreground_spawn_failed", outcome: "command_not_started", err, workspaceId },
          "failed to spawn Docker foreground command",
        );
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
        log.error(
          { event: "docker_foreground_process_error", outcome: "command_failed", err, workspaceId },
          "Docker foreground command process error",
        );
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
      // Deliberately no secret env. apt still reaches the credential proxy, because the proxy URL
      // and CA-trust vars are container-level (buildRunEnv) and every exec inherits them; the
      // per-command env carries only the workspace's secret tokens, which apt has no use for. This
      // is the one exec that runs as root, so it gets the least it can work with.
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
    // A background process keeps whatever env it launched with — it is a running process, not a
    // container. That is not a way to outlive a revoked secret: the token is opaque and inert once
    // the proxy drops its rule, which happens the moment the secret is deleted.
    return this.background.start(workspaceId, command, this.execEnv(workspaceId));
  }

  async stopBackground(workspaceId: string, taskId: string): Promise<boolean> {
    return this.background.stop(workspaceId, taskId);
  }

  listBackground(workspaceId: string): BackgroundTask[] {
    return this.background.list(workspaceId);
  }

  /**
   * Apply a workspace's internet-access setting to its live network, leaving the container alone.
   *
   * Docker cannot flip `--internal` on an existing network, so the network itself is rebuilt — but
   * `network disconnect` / `network connect` both work on a RUNNING container, so the container
   * keeps its identity and, crucially, everything the agent installed in it. Connections open at
   * the moment egress is switched off are dropped along with the interface, which is the intent.
   *
   * Confirmable by design: throws if the new network could not be put in place, so the caller can
   * roll the persisted setting back rather than reporting a boundary it never actually applied.
   */
  async applyInternetAccess(workspaceId: string, enabled: boolean): Promise<void> {
    // Wait out any in-flight ensure()/stop() before claiming the slot, so this can't interleave
    // with a bring-up that is halfway through wiring the old network. Mirrors stop().
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      // Only a RUNNING container has live networking to correct. A workspace that has never started
      // has no network yet, and stop() removes the network of one that has — in both cases the next
      // bring-up creates it with the flag this setting has already been persisted as, so building
      // one here would only leave a network nothing is attached to, lingering until the workspace is
      // next woken (and Docker's address pool is finite).
      const status = await this.getContainerStatus(workspaceId);
      if (status !== "running") return;

      await this.reconcileNetwork(workspaceId, enabled);
    })();

    // Tagged "stop" so a concurrent ensure() waits it out instead of piggybacking — this promise
    // resolves to "network reconciled", not "container ready".
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      // Identity-checked like ensure() and stop(): only ever clear our own entry, never one a
      // later operation has since claimed.
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
  }

  // On boot, reconnect the credproxy sidecar to every running workspace network that should have
  // one (prod-only) — excludes internet-access-off workspaces, see ProxyNetworkManager.reattachAll.
  // Fails closed (excluded) if the workspace record can't be found at all.
  async reattachProxyNetworks(): Promise<void> {
    await this.proxy.reattachAll((workspaceId) => {
      return this.workspaceDeps.internetAccessFor(workspaceId);
    });
  }

  async stop(workspaceId: string): Promise<void> {
    // Wait out anything already in flight (an ensure() or another stop()) before claiming the slot
    // for our own teardown, so a concurrent ensure() (e.g. an agent tool call racing the
    // internet-access toggle route) can't interleave with this — reattaching the sidecar right as
    // we're trying to tear the network down, or vice versa. See ensure() above for the matching half.
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      const t = this.idleTimers.get(workspaceId);
      if (t) {
        clearTimeout(t);
        this.idleTimers.delete(workspaceId);
      }
      // Background processes die with the container (tini reaps the tree) — just drop the bookkeeping.
      this.background.clear(workspaceId);
      const r = await this.docker.cmd("stop", containerName(workspaceId));
      // A workspace that never ran has no container and is already in the desired stopped state.
      // Every other non-zero result means Docker could not confirm the teardown; surface that to
      // the internet-access operation after still attempting the idempotent network cleanup below.
      const stopError =
        r.code !== 0 && !/no such container/i.test(r.stderr)
          ? new Error(`docker stop failed: ${r.stderr || `exit ${r.code}`}`)
          : null;
      if (stopError) log.warn({ workspaceId, stderr: r.stderr }, "docker stop failed");
      await this.docker.cmd("network", "disconnect", networkName(workspaceId), containerName(workspaceId));
      await this.proxy.detach(workspaceId);
      const net = await this.docker.cmd("network", "rm", networkName(workspaceId));
      if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "network rm on stop (may not exist)");
      if (stopError) throw stopError;
    })();
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
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
      log.fatal(
        { event: "startup_docker_unavailable", outcome: "process_exit", stderr: r.stderr },
        "Docker is not available. Make sure Docker is running before starting the server.",
      );
      exitAfterLogs(1);
    }
    try {
      await this.imageManager.ensureImage(CONTAINER_IMAGE, "Dockerfile.workspace");
    } catch (err) {
      log.fatal(
        {
          event: "startup_workspace_image_unavailable",
          outcome: "process_exit",
          err,
          image: CONTAINER_IMAGE,
        },
        "workspace image could not be inspected or built — refusing to start",
      );
      exitAfterLogs(1);
    }
  }
}
