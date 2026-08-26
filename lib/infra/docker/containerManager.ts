// Manages the Docker container lifecycle for each workspace.
// One container per workspace — started eagerly when an agent session begins, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Network naming:   wsnet_<workspaceId>  (isolated per-workspace bridge — no inter-container traffic)
// Bind mounts:      <workspaceDir> → /workspace  (host files, shared with file tools)
//                   <homeDir>      → /home/dev   (durable agent home — see seedAgentHome)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS / CONTAINER_PIDS_LIMIT env vars
//                   (defaults: 1g / 1.0 / 512)
import { access, mkdir, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { createLogger, exitAfterLogs } from "../logger";
import { envArgs, type IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import type { IContainerManager, OutputSink } from "../interfaces";
import { EXEC_OUTPUT_MAX_BYTES, EXEC_OUTPUT_KEEP, EXEC_OUTPUT_MAX_BACKLOG, EXEC_KILL_GRACE_MS } from "../limits";
import { containerName, networkName } from "./naming";
import { workspaceHomeDir, workspaceHomeSeededMarker, workspaceHomeSubpath } from "../paths";
import { readAptRecipe } from "../aptRecipe";
import { BackgroundTaskManager, type BackgroundTask } from "./backgroundTaskManager";
import { ProxyNetworkManager } from "./proxyNetworkManager";
import { capacityProfile } from "../capacityProfile";
import { asDockerNetworkPoolExhaustedError, reportInfrastructureResourceExhaustion } from "./infrastructureFailure";

// Re-exported for back-compat with external consumers.
export type { BackgroundTask } from "./backgroundTaskManager";

const log = createLogger("container");

// Runs an output-stream callback so a throw inside it degrades this one command instead of killing
// the process. See the call sites in execStreaming for why an uncaught throw there is fatal.
function safeEmit(emit: () => void, workspaceId: string): void {
  try {
    emit();
  } catch (err) {
    log.error(
      { event: "docker_output_handler_failed", outcome: "output_chunk_dropped", err, workspaceId },
      "output handler threw — dropping this chunk",
    );
  }
}

/** Docker deletion is idempotent only when the named resource is explicitly absent. */
function isMissingContainer(stderr: string): boolean {
  return /no such container/i.test(stderr);
}

function isMissingNetwork(stderr: string): boolean {
  return /no such network|network\s+\S+\s+not found/i.test(stderr);
}

function dockerCleanupFailure(stage: string, result: { code: number; stderr: string }): string {
  return `${stage}: ${result.stderr || `exit ${result.code}`}`;
}

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = capacityProfile.workspaceMemoryLimit;
const CONTAINER_CPUS = capacityProfile.workspaceCpus;
// Max processes+threads in the container's pid cgroup. Docker's default is unlimited, which lets a
// fork bomb (or a runaway spawn loop) in ANY workspace exhaust the host's global pid_max — at which
// point nothing on the host can fork, including the `docker exec` this app spawns per command. The
// memory cap is not a backstop: a forking cgroup under memory pressure thrashes the OOM killer
// rather than stopping. Threads count too, so anything thread-heavy (JVM, browser grids, `make -j`)
// needs this raised. Hitting the cap surfaces as "Resource temporarily unavailable" on fork.
const CONTAINER_PIDS = capacityProfile.workspacePidsLimit;
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Where a command's over-cap output is parked so the agent can still read it (see ExecOutput).
// Deliberately alongside /tmp/paodo-tasks: the agent is already taught to tail paths of that shape,
// and neither is visible to the file tree, to git, or to workspace snapshots — which matters here,
// because snapshots stage with `add --all --force` and would otherwise commit every spill file.
const EXEC_OUTPUT_DIR = "/tmp/paodo-exec";
// Where execStreaming parks a command's session-leader pid so its group can be killed later. Split
// into dir + prefix so the file it writes and the sweep that clears them can never drift apart.
const EXEC_PIDFILE_DIR = "/tmp";
const EXEC_PIDFILE_PREFIX = "paodo-exec-";
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";
// The agent's home inside the container — the `dev` user created in Dockerfile.workspace. Mounted
// from durable storage, so npm globals, pip packages and extra node/python versions outlive the
// container. SEED_TARGET is where the same directory is attached while it is being filled.
const AGENT_HOME = "/home/dev";
const SEED_TARGET = "/seed";

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
  // Permanent for this process once explicit deletion begins. Workspace deletion removes secrets,
  // graph edges and other state before the registry, so a failed/partial deletion must not let an
  // in-flight agent recreate the container while the caller retries the cleanup.
  private removingWorkspaces = new Set<string>();

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
    const args = [
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      "com.paodo.managed=workspace",
      "--label",
      `com.paodo.workspace-id=${workspaceId}`,
    ];
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

  // Production (WORKSPACES_VOLUME_NAME set) uses Docker 25+ volume-subpath mounting: the Docker
  // daemon sees host paths, not app-container paths, so a plain bind of /app/data/<id> hits nothing.
  // Local dev (app on the host) falls back to a plain bind so it works without Docker Compose.
  private buildMountArg(hostDir: string, subpath: string, target: string): string[] {
    if (!WORKSPACES_VOLUME_NAME) return ["-v", `${hostDir}:${target}`];
    return ["--mount", `type=volume,source=${WORKSPACES_VOLUME_NAME},target=${target},volume-subpath=${subpath}`];
  }

  // Both durable mounts: the workspace tree the user sees, and the agent's home. Everything the
  // agent can write therefore survives container recreation — see seedAgentHome for why home needs it.
  private buildVolumeArgs(workspaceId: string, workspaceDir: string): string[] {
    return [
      ...this.buildMountArg(workspaceDir, path.basename(workspaceDir), "/workspace"),
      ...this.buildMountArg(workspaceHomeDir(workspaceId), workspaceHomeSubpath(workspaceId), AGENT_HOME),
    ];
  }

  /**
   * Fill a workspace's durable home from the image, once, before its container first starts.
   *
   * The image ships ~250MB under /home/dev (nvm's Node, pyenv) that the mount would otherwise hide,
   * leaving the workspace with no node and no python at all. A throwaway root container copies that
   * tree in with `cp -a`, preserving uid 1000 ownership so the agent can still write it afterwards.
   *
   * Fatal on failure by design: a container started on an empty home is broken in a way that reads
   * as "node is missing" rather than "setup failed", so this fails loudly at create instead. The
   * marker written at the end is what makes that hold on the retry too — see below.
   */
  private async seedAgentHome(workspaceId: string): Promise<void> {
    const homeDir = workspaceHomeDir(workspaceId);
    // Must exist before docker run either way: volume-subpath refuses to mount a missing subpath.
    await mkdir(homeDir, { recursive: true });
    // A marker, not the directory's contents, is what says "done": a copy killed partway (disk full,
    // host restart) leaves files that would otherwise pass for a finished seed forever after.
    const marker = workspaceHomeSeededMarker(workspaceId);
    const seeded = await access(marker).then(
      () => true,
      () => false,
    );
    if (seeded) return;

    const r = await this.docker.cmd(
      "run",
      "--rm",
      "-u",
      "0",
      // It copies a directory and exits; nothing here should be reachable from or over the network.
      "--network",
      "none",
      ...this.buildMountArg(homeDir, workspaceHomeSubpath(workspaceId), SEED_TARGET),
      CONTAINER_IMAGE,
      // Overwrites what it finds rather than skipping it, so a retry completes a partial home.
      "cp",
      "-a",
      `${AGENT_HOME}/.`,
      `${SEED_TARGET}/`,
    );
    if (r.code !== 0) throw new Error(`agent home seed failed: ${r.stderr || `exit ${r.code}`}`);
    await writeFile(marker, "");
    log.info(
      { event: "workspace_agent_home_seeded", outcome: "agent_home_ready", workspaceId },
      "agent home seeded from image",
    );
  }

  /**
   * Installs the recipe, returning the packages that could not be installed.
   *
   * One call first, because that is the case that always works and it resolves the set together.
   * But apt-get commits or aborts the WHOLE transaction, so a single package the repos no longer
   * carry — an aged-out pin, a rename — would otherwise take every other package down with it and
   * hand back a bare container. The retry costs one apt-get per package, and only when something is
   * already wrong, to salvage everything that is still installable.
   */
  private async installRecipePackages(
    name: string,
    packages: string[],
    asRoot: { asRoot: true; trimStdout: true },
  ): Promise<string[]> {
    const install = (pkgs: string[]) =>
      this.docker.exec(name, ["apt-get", "install", "-y", "--no-install-recommends", ...pkgs], asRoot);

    if ((await install(packages)).code === 0) return [];

    const failed: string[] = [];
    for (const pkg of packages) {
      if ((await install([pkg])).code !== 0) failed.push(pkg);
    }
    return failed;
  }

  /** Severity tracks how much of the workspace's tooling is actually missing, not whether apt erred. */
  private reportReplay(workspaceId: string, packages: string[], failed: string[]): void {
    const restored = packages.filter((p) => !failed.includes(p));
    if (failed.length === 0) {
      log.info(
        { event: "apt_recipe_replayed", outcome: "system_packages_restored", workspaceId, packages },
        "reinstalled system packages into rebuilt container",
      );
      return;
    }
    const total = { workspaceId, failed, restored, failedCount: failed.length, restoredCount: restored.length };
    if (restored.length === 0) {
      log.error(
        { event: "apt_recipe_replay_failed", outcome: "system_packages_not_restored", ...total },
        "apt recipe replay failed — the rebuilt container has none of its system packages",
      );
      return;
    }
    log.warn(
      { event: "apt_recipe_replay_incomplete", outcome: "system_packages_partially_restored", ...total },
      "apt recipe replay incomplete — some system packages are missing from the rebuilt container",
    );
  }

  /**
   * Reinstalls the system packages this workspace had before its container was rebuilt.
   *
   * Only the create path calls this: `docker start` on a stopped container keeps its writable layer,
   * so the packages are still there. Never throws — a workspace missing ffmpeg is degraded, one that
   * refuses to start is dead, and the agent can always run apt_install again.
   */
  private async replayAptRecipe(workspaceId: string, internetAccess: boolean): Promise<void> {
    const packages = readAptRecipe(workspaceId);
    if (packages.length === 0) return;
    // An internet-less workspace sits on an --internal network with no route to the repos. Expected,
    // not a failure: apt_install is not even offered to the agent in that state (see buildTools).
    if (!internetAccess) {
      log.info(
        { event: "apt_recipe_replay_skipped", outcome: "system_packages_not_restored", workspaceId, packages },
        "skipping apt recipe replay — workspace has no internet access",
      );
      return;
    }

    const name = containerName(workspaceId);
    const asRoot = { asRoot: true, trimStdout: true } as const;
    try {
      const update = await this.docker.exec(name, ["apt-get", "update"], asRoot);
      if (update.code !== 0) {
        log.error(
          {
            event: "apt_recipe_replay_failed",
            outcome: "system_packages_not_restored",
            workspaceId,
            packages,
            stderr: update.stderr,
          },
          "apt index refresh failed — the rebuilt container has none of its system packages",
        );
        return;
      }
      const failed = await this.installRecipePackages(name, packages, asRoot);
      this.reportReplay(workspaceId, packages, failed);
    } catch (err) {
      log.error(
        { event: "apt_recipe_replay_failed", outcome: "system_packages_not_restored", err, workspaceId, packages },
        "apt recipe replay failed — the rebuilt container has none of its system packages",
      );
    } finally {
      // Same reason as the apt_install tool: the .debs and the index are pure download cache, and
      // this container is never recreated, so anything left here accumulates for its whole life.
      await this.docker
        .exec(name, ["/bin/sh", "-c", "apt-get clean; rm -rf /var/lib/apt/lists/*"], asRoot)
        .catch(() => {});
    }
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

      // An existing container is ALWAYS reused as-is — drift from the image is intended, not stale.
      // Its state is recoverable anyway: /home/dev is durable, and apt packages replay from the recipe.
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
        await this.sweepExecPidFiles(workspaceId);
        return;
      }

      // missing — first run for this workspace, so create and start
      log.debug({ workspaceId }, "creating container");
      stage = "ensure_network";
      await this.ensureNetwork(workspaceId, internetAccess);
      // Before the container exists, so its /home/dev mount has the image's runtimes to start from.
      stage = "seed_agent_home";
      await this.seedAgentHome(workspaceId);
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
        ...this.buildVolumeArgs(workspaceId, workspaceDir),
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
      log.info(
        {
          event: "workspace_container_capacity_applied",
          outcome: "workspace_container_created",
          workspaceId,
          containerMemoryLimit: CONTAINER_MEMORY,
          containerCpus: CONTAINER_CPUS,
          containerPidsLimit: CONTAINER_PIDS,
        },
        "workspace container created with capacity guardrails",
      );

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

      // After the CA, not before: apt reaches the repos through the credential proxy, and the
      // GitHub CLI source the image adds is HTTPS, so an untrusted CA fails the refresh outright.
      stage = "replay_apt_recipe";
      await this.replayAptRecipe(workspaceId, internetAccess);
    } catch (err) {
      const exhaustion = asDockerNetworkPoolExhaustedError(err);
      if (!reportInfrastructureResourceExhaustion(log, exhaustion ?? err, { workspaceId, stage })) {
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
      }
      throw exhaustion ?? err;
    }
  }

  async ensure(workspaceId: string, workspaceDir: string): Promise<void> {
    // Coalesce concurrent ensure() calls onto one in-flight promise. But a concurrent stop() (e.g.
    // the internet-access toggle route) is never piggybacked on — its promise resolves to
    // "stopped," which is the opposite of what an ensure() caller wants — so wait it out and then
    // run our own fresh ensure. The check-then-set below has no `await` in between, so nothing else
    // can claim the slot while we're mid-loop.
    for (;;) {
      if (this.removingWorkspaces.has(workspaceId)) {
        throw new Error(`workspace ${workspaceId} is being permanently deleted`);
      }
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
          const exhaustion = asDockerNetworkPoolExhaustedError(err);
          if (
            !reportInfrastructureResourceExhaustion(log, exhaustion ?? err, {
              workspaceId,
              stage: "verify_proxy_network",
            })
          ) {
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
          }
          throw exhaustion ?? err;
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

  /**
   * Clear exec pid files orphaned by a container stop.
   *
   * Only the kill path removes a pid file; a command that simply finishes leaves its own behind. A
   * container lives for the whole life of its workspace and nothing else ever clears its /tmp, so
   * without this those files accumulate for as long as the workspace exists.
   *
   * Runs ONLY on the restart path, which is what makes it safe without an age heuristic: the stop
   * killed every process in the container, so nothing left in here can belong to a live command.
   * `find -delete` rather than `rm -f` with a glob, so a long-neglected container cannot blow ARG_MAX.
   */
  private async sweepExecPidFiles(workspaceId: string): Promise<void> {
    const script = `find ${EXEC_PIDFILE_DIR} -maxdepth 1 -type f -name '${EXEC_PIDFILE_PREFIX}*.pid' -delete`;
    // Best effort: leftover pid files cost disk, never correctness, so a failure here must not stop
    // a container that has otherwise started cleanly.
    const r = await this.docker.exec(containerName(workspaceId), ["/bin/bash", "-c", script]).catch((err) => {
      log.warn({ err, workspaceId }, "failed to sweep orphaned exec pid files");
      return null;
    });
    if (r && r.code !== 0) {
      log.warn({ workspaceId, stderr: r.stderr }, "failed to sweep orphaned exec pid files");
    }
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
      const pidFile = `${EXEC_PIDFILE_DIR}/${EXEC_PIDFILE_PREFIX}${randomUUID()}.pid`;
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
      // Both handlers are wrapped because Node invokes them directly, off any promise chain: an
      // exception thrown in here does NOT reach the .catch() around execStreaming, it reaches
      // process.on("uncaughtException") in server.ts, which fatal()s the whole instance. That is
      // precisely how an unbounded `stdout += chunk` used to take down every workspace at once.
      // ExecOutput now caps the accumulation, so this is the backstop, not the fix — it exists so no
      // future bug in an output handler can ever be an instance-wide outage again.
      proc.stdout!.on("data", (chunk: Buffer) => safeEmit(() => opts.onStdout(chunk.toString()), workspaceId));
      proc.stderr!.on("data", (chunk: Buffer) => safeEmit(() => opts.onStderr(chunk.toString()), workspaceId));

      let killed = false;
      // Signals the whole in-container process group via the recorded session leader. Only the last
      // signal a command will ever get removes the pid file — the escalation still needs to read it.
      const signalGroup = (killSignal: "TERM" | "KILL", removePidFile: boolean) =>
        this.docker
          .exec(name, [
            "/bin/bash",
            "-c",
            `kill -${killSignal} -"$(cat ${pidFile} 2>/dev/null)" 2>/dev/null` +
              (removePidFile ? `; rm -f ${pidFile}` : ""),
          ])
          .catch((err) =>
            log.warn({ err, workspaceId, killSignal }, "failed to signal aborted foreground command inside container"),
          );

      // Ask, then force. The grace window is what lets git drop its index.lock and npm clear its
      // staging dir, so an interrupted command leaves a clean workspace rather than a repair job.
      const kill = () => {
        if (killed) return;
        killed = true;
        signalGroup("TERM", false);
        // The host-side client is deliberately left alone until the escalation: dropping it while
        // the group still lives orphans the command onto PID 1, which the pid-file kill exists to avoid.
        const escalation = setTimeout(() => {
          signalGroup("KILL", true);
          proc.kill("SIGKILL");
        }, EXEC_KILL_GRACE_MS);
        escalation.unref?.();
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
        // A pending escalation is deliberately NOT cancelled here: `setsid --wait` returns when the
        // group LEADER exits, so a sibling that blocked SIGTERM would be left with nothing to kill it.
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

  /**
   * Opens a drain inside the container for output the app will not hold in memory.
   *
   * Deliberately a SEPARATE `docker exec` rather than a tee bolted onto execStreaming's launcher:
   * that launcher records the pid the process-group kill depends on, and adding redirections to it
   * to serve a logging feature would put the one reliable way of stopping a runaway command at risk.
   * This costs an extra process, but only for commands that already blew the cap.
   *
   * The container is necessarily running by the time this is called — a command is mid-flight — so
   * there is no ensure() here.
   */
  openOutputSink(workspaceId: string, runId: string): OutputSink {
    // runId reaches a shell command below. Today's only caller passes randomUUID(), so this cannot
    // currently carry anything hostile — it is here so that stays true if a caller ever passes
    // something derived from a command, a filename, or anything else the agent can influence.
    const safeId = runId.replace(/[^a-zA-Z0-9-]/g, "") || "run";
    const file = `${EXEC_OUTPUT_DIR}/${safeId}.output`;
    // `head -c` stops reading at the ceiling and exits, which closes our stdin — the EPIPE that
    // follows is the expected signal that the file is full, not an error. The prune keeps this
    // directory from growing for the container's whole lifetime.
    //
    // The `-mmin +1` is the part that is not obvious: the prune runs while OTHER commands may be
    // mid-spill, and deleting one of those unlinks a file the agent was just told to go read (the
    // writer keeps filling the now-nameless inode, so the loss is silent). Age excludes any file
    // still being written to; the count is what actually bounds the directory.
    const script =
      `mkdir -p ${EXEC_OUTPUT_DIR}; ` +
      `ls -1t ${EXEC_OUTPUT_DIR}/*.output 2>/dev/null | tail -n +${EXEC_OUTPUT_KEEP} | ` +
      `xargs -r find -mmin +1 2>/dev/null | xargs -r rm -f; ` +
      `head -c ${EXEC_OUTPUT_MAX_BYTES} > ${file}`;

    let alive = true;
    let truncated = false;
    let written = 0;
    let proc: ReturnType<typeof spawn> | null = null;

    const stop = (wasTruncated: boolean) => {
      if (!alive) return;
      alive = false;
      truncated = truncated || wasTruncated;
      try {
        proc?.stdin?.end();
      } catch {
        // Already torn down — nothing left to close.
      }
    };

    try {
      // stdin only. The sink's whole job is to take bytes; nothing reads what the drain prints, and
      // a piped stream no one reads is a buffer no one empties.
      proc = spawn("docker", ["exec", "-i", containerName(workspaceId), "/bin/bash", "-c", script], {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch (err) {
      log.warn({ err, workspaceId }, "failed to open command output sink — over-cap output will not be saved");
      alive = false;
    }
    // EPIPE here is the normal end of a capped file, so this is a warn-free path; the error is only
    // interesting as the reason writing stopped.
    proc?.stdin?.on("error", () => stop(true));
    proc?.on("error", (err) => {
      log.warn({ err, workspaceId }, "command output sink failed — saved output may be incomplete");
      stop(true);
    });

    return {
      path: file,
      limit: EXEC_OUTPUT_MAX_BYTES,
      get truncated() {
        return truncated;
      },
      write(chunk: Buffer) {
        if (!alive || !proc?.stdin) return;
        // Backpressure, not byte count, is the real memory risk: an undrained pipe queues in this
        // process's heap. Past the backlog ceiling the file is left as a prefix rather than letting
        // that queue grow — the file is a convenience, staying alive is not.
        if (proc.stdin.writableLength > EXEC_OUTPUT_MAX_BACKLOG) {
          stop(true);
          return;
        }
        written += chunk.length;
        if (written > EXEC_OUTPUT_MAX_BYTES) truncated = true;
        proc.stdin.write(chunk);
      },
      close() {
        stop(false);
      },
    };
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
    // Mark first so no new ensure() can claim the slot while we wait for an existing start/stop to
    // finish. The marker deliberately survives a cleanup failure: deletion has already removed other
    // workspace-owned state, so reviving the container would race the retry and restore only part of
    // a workspace the user asked to remove.
    this.removingWorkspaces.add(workspaceId);
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
      this.background.clear(workspaceId);
      // Attempt every teardown step even if one fails, but ignore a non-zero result ONLY when Docker
      // explicitly says the resource is absent. Treating daemon/permission/conflict failures as "may
      // not exist" lets workspace deletion remove the registry while a live container survives it.
      const failures: string[] = [];
      const stop = await this.docker.cmd("stop", containerName(workspaceId));
      if (stop.code !== 0 && !isMissingContainer(stop.stderr)) {
        failures.push(dockerCleanupFailure("docker stop", stop));
      }
      const remove = await this.docker.cmd("rm", containerName(workspaceId));
      if (remove.code !== 0 && !isMissingContainer(remove.stderr)) {
        failures.push(dockerCleanupFailure("docker rm", remove));
      }
      try {
        await this.proxy.detach(workspaceId);
      } catch (err) {
        failures.push(`credential proxy detach: ${(err as Error).message}`);
      }
      const net = await this.docker.cmd("network", "rm", networkName(workspaceId));
      if (net.code !== 0 && !isMissingNetwork(net.stderr)) {
        failures.push(dockerCleanupFailure("docker network rm", net));
      }
      if (failures.length > 0) {
        throw new Error(`workspace Docker cleanup failed: ${failures.join("; ")}`);
      }
    })();

    // Reuse the teardown lock kind: ensure() must not coalesce onto a promise whose result means the
    // container is gone. The permanent marker above makes it reject rather than restart afterward.
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
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
