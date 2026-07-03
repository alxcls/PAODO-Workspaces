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
import { lookup } from "dns/promises";
import { getFreePort, cachePort, getCachedPort, invalidatePort, queryDockerPort } from "./portAllocator";
import path from "path";
import { createLogger } from "../logger";
import { DockerClient, IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import type { IContainerManager } from "../interfaces";
import { existsSync } from "fs";
import { listSecretMeta, proxyToken } from "../security/workspaceSecretStore";
import { deriveProxySecret } from "../proxy/proxyCA";
import { WORKSPACES_ROOT } from "../paths";

export type { DockerResult } from "./dockerClient";

const log = createLogger("container");

// Label recording which secrets were baked into the container's env at creation time (as a
// hash of their sorted names — token values are derived from name+workspaceId alone, so a name
// hash is enough to detect additions/removals; domain-only changes don't affect env args).
const SECRETS_LABEL = "paodo.workspace-secrets-hash";

function hashSecretNames(secrets: { name: string }[]): string {
  const sorted = secrets.map((s) => s.name).sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";
const CREDENTIAL_PROXY_PORT = process.env.CREDENTIAL_PROXY_PORT ?? "9998";

// Combined CA bundle (container system roots + proxy CA) that replacement-style trust vars
// (REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / SSL_CERT_FILE) point at. Built by the bootstrap exec.
const COMBINED_CA_BUNDLE = "/etc/proxy-ca-bundle.crt";

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
      const containerHash = await this.imageManager.getContainerImageHash(this.containerName(workspaceId));
      const containerSecretsHash = await this.getContainerSecretsHash(this.containerName(workspaceId));
      const portMissing = (await this.getServerPort(workspaceId)) === null;
      const imageMatches = !hash || containerHash === hash;
      const secretsMatch = containerSecretsHash === secretsHash;
      if (imageMatches && secretsMatch) {
        if (!portMissing) {
          if (status === "running") return;
          // stopped, image unchanged, secrets unchanged, port mapped — just restart it
          log.debug({ workspaceId }, "starting stopped container");
          await this.ensureNetwork(workspaceId);
          const connect = await this.docker.cmd(
            "network",
            "connect",
            this.networkName(workspaceId),
            this.containerName(workspaceId),
          );
          if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
          const r = await this.docker.cmd("start", this.containerName(workspaceId));
          if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
          return;
        }
        // Port mapping missing (container predates this feature) — recreate to add it.
        log.debug({ workspaceId }, "container missing server port mapping — recreating");
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
    const serverPort = await getFreePort();
    const bindHost = await resolveBindHost();

    // Build per-workspace secret token env vars (tokens only — real values stay in the proxy).
    const secrets = listSecretMeta(workspaceId);
    const secretEnvArgs = secrets.flatMap((s) => ["-e", `${s.name}=${proxyToken(workspaceId, s.name)}`]);
    // Path is deterministic — avoids module-isolation issues with getCACertPath() across Next.js bundles.
    const caCertPath = path.join(WORKSPACES_ROOT, ".proxy-ca", "ca.crt");
    // The proxy is only wired up when its CA exists. deriveProxySecret needs the HMAC key that
    // ensureCA creates alongside the CA, so computing the URL inside this branch keeps container
    // creation working before the proxy is set up. The password is the workspace's derived proxy
    // secret, so the proxy can verify this container is who it claims to be — a container that knows
    // another workspace's id still can't forge its identity.
    const hasProxyCA = existsSync(caCertPath);
    const proxyUrl = hasProxyCA
      ? `http://${workspaceId}:${deriveProxySecret(workspaceId)}@host.docker.internal:${CREDENTIAL_PROXY_PORT}`
      : "";
    const proxyEnvArgs = hasProxyCA ? [
      // --add-host makes host.docker.internal resolve to the host gateway on Linux Docker
      "--add-host=host.docker.internal:host-gateway",
      "-e", `HTTP_PROXY=${proxyUrl}`,
      "-e", `HTTPS_PROXY=${proxyUrl}`,
      // NODE_EXTRA_CA_CERTS is additive (appended to Node's built-in roots), so it can point
      // at the proxy CA alone. REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / SSL_CERT_FILE are
      // *replacement* trust stores — pointing them at the proxy CA alone drops the public
      // roots, so TLS to tunneled (non-MITM'd) hosts like pypi.org fails with "unable to get
      // local issuer certificate". They instead point at a combined bundle (system roots +
      // proxy CA) that the bootstrap exec builds below.
      "-e", "NODE_EXTRA_CA_CERTS=/etc/proxy-ca.crt",
      "-e", `REQUESTS_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
      "-e", `CURL_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
      "-e", `SSL_CERT_FILE=${COMBINED_CA_BUNDLE}`,
      "-v", `${caCertPath}:/etc/proxy-ca.crt:ro`,
    ] : [];

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
      ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
      "--label", `${SECRETS_LABEL}=${secretsHash}`,
      ...proxyEnvArgs,
      ...secretEnvArgs,
      // Drop all Linux capabilities, then add back only the minimal set dpkg/apt and the chown sweep
      // need when run as root via `docker exec -u 0` (apt_install tool, ownership sweep). The agent's
      // shell is non-root with no setuid path, so it cannot use these caps — they are reachable only
      // by the app-initiated root execs. Combined with no-new-privileges this blocks setuid escalation.
      "--cap-drop", "ALL",
      "--cap-add", "CHOWN",
      "--cap-add", "DAC_OVERRIDE",
      "--cap-add", "FOWNER",
      "--cap-add", "FSETID",
      "--cap-add", "SETGID",
      "--cap-add", "SETUID",
      "--security-opt", "no-new-privileges:true",
      CONTAINER_IMAGE,
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

    // Build the combined CA bundle the replacement-style trust vars point at: the image's own
    // system roots concatenated with the mounted proxy CA. Without the system roots, TLS to
    // tunneled (non-MITM'd) hosts like pypi.org fails to verify. If the system bundle is missing,
    // fall back to the proxy CA alone (MITM hosts still verify; tunneled ones degrade as before).
    if (existsSync(path.join(WORKSPACES_ROOT, ".proxy-ca", "ca.crt"))) {
      const caBundle = await this.docker.exec(
        this.containerName(workspaceId),
        ["sh", "-c",
          `cat /etc/ssl/certs/ca-certificates.crt /etc/proxy-ca.crt > ${COMBINED_CA_BUNDLE} 2>/dev/null || ` +
          `cp /etc/proxy-ca.crt ${COMBINED_CA_BUNDLE}`],
        { asRoot: true, trimStdout: true },
      );
      if (caBundle.code !== 0)
        log.debug({ workspaceId, stderr: caBundle.stderr }, "combined CA bundle build failed (non-fatal)");
    }
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
