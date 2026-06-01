// Manages the Docker container lifecycle for each workspace.
// One container per workspace — started eagerly when an agent session begins, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Network naming:   wsnet_<workspaceId>  (isolated per-workspace bridge — no inter-container traffic)
// Bind mount:       <workspaceDir> → /workspace  (host files, shared with file tools)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS env vars (defaults: 1g / 1.0)
import { spawn } from "child_process";
import { createHash } from "crypto";
import { readFile, rm } from "fs/promises";
import path from "path";
import { createLogger } from "./logger";
import { getGlobalLock } from "./permissionStore";
import { reconcileOsPermissions } from "./osLock";

const log = createLogger("container");

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const HASH_LABEL = "paodo.workspace-hash";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;
// Docker volume name is deterministic: compose project name (fixed in docker-compose.yml as
// "paodo_ws") + "_" + volume key ("workspaces"). Falls back to a plain bind mount when unset
// so local dev (app running directly on host) still works without Docker Compose.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Prevents concurrent docker run/start calls for the same workspace.
const startLocks = new Map<string, Promise<void>>();

function containerName(workspaceId: string): string {
  return `ws_${workspaceId}`;
}

function networkName(workspaceId: string): string {
  return `wsnet_${workspaceId}`;
}

async function ensureNetwork(workspaceId: string): Promise<void> {
  const name = networkName(workspaceId);
  const inspect = await dockerCmd("network", "inspect", name);
  if (inspect.code === 0) return;
  const r = await dockerCmd("network", "create", "--driver", "bridge", name);
  if (r.code !== 0) throw new Error(`docker network create failed: ${r.stderr}`);
}

export type DockerResult = { stdout: string; stderr: string; code: number };

function dockerCmd(...args: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", args);
    } catch (err) {
      // spawn can throw synchronously (e.g. EBADF during Next.js compilation) before
      // the child process is created, so proc.on("error") never fires in that case.
      resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
      return;
    }
    proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdout!.on("error", () => {});
    proc.stderr!.on("error", () => {});
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
  });
}

async function getContainerStatus(workspaceId: string): Promise<"running" | "stopped" | "missing"> {
  const r = await dockerCmd("inspect", "--format", "{{.State.Status}}", containerName(workspaceId));
  if (r.code !== 0) return "missing";
  if (r.stdout === "running") return "running";
  return "stopped";
}

function resetIdleTimer(workspaceId: string): void {
  const existing = idleTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => stopContainer(workspaceId), IDLE_TIMEOUT_MS);
  t.unref();
  idleTimers.set(workspaceId, t);
}

const LOCK_LABEL = "paodo.workspace-locked";

// Builds the volume args for docker run.
// When WORKSPACES_VOLUME_NAME is set (production / Docker Compose), uses Docker 25+ volume
// subpath mounting — necessary because the Docker daemon sees host paths, not app-container
// paths, so a plain -v /app/data/<name>:/workspace would point at a non-existent host path.
// When unset (local dev, app runs directly on host), falls back to a plain bind mount using
// the resolved host path so local workspaces work without Docker Compose.
// readOnly mounts /workspace with MS_RDONLY — blocks all writes regardless of user or UID
// mapping (important on macOS where VirtioFS bind mounts ignore container user permissions).
function buildVolumeArg(workspaceDir: string, readOnly: boolean): string[] {
  if (!WORKSPACES_VOLUME_NAME) {
    return ["-v", `${workspaceDir}:/workspace${readOnly ? ":ro" : ""}`];
  }
  const workspaceName = path.basename(workspaceDir);
  return [
    "--mount",
    `type=volume,source=${WORKSPACES_VOLUME_NAME},target=/workspace,volume-subpath=${workspaceName}${readOnly ? ",readonly" : ""}`,
  ];
}

async function getContainerLockLabel(workspaceId: string): Promise<boolean> {
  const r = await dockerCmd("inspect", "--format", `{{index .Config.Labels "${LOCK_LABEL}"}}`, containerName(workspaceId));
  return r.code === 0 && r.stdout === "true";
}

async function _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
  const [status, isLocked] = await Promise.all([
    getContainerStatus(workspaceId),
    getGlobalLock(workspaceId),
  ]);

  if (status === "running" || status === "stopped") {
    const containerLocked = await getContainerLockLabel(workspaceId);
    if (containerLocked === isLocked) {
      if (status === "running") return;
      // stopped, same lock state — just restart it
      log.debug({ workspaceId }, "starting stopped container");
      await ensureNetwork(workspaceId);
      const connect = await dockerCmd("network", "connect", networkName(workspaceId), containerName(workspaceId));
      if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
      const r = await dockerCmd("start", containerName(workspaceId));
      if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
      // Re-apply OS-level locks/crowns after restart (state survives in the JSON registries).
      await reconcileOsPermissions(workspaceId);
      return;
    }
    // Lock state changed — remove so we recreate with the correct mount mode below.
    log.debug({ workspaceId, isLocked }, "lock state changed — recreating container with updated mount");
    await removeContainer(workspaceId);
  }

  // missing (or just removed) — create and start
  log.debug({ workspaceId }, "creating container");
  await ensureNetwork(workspaceId);
  const r = await dockerCmd(
    "run", "-d",
    "--name", containerName(workspaceId),
    "--network", networkName(workspaceId),
    `--memory=${CONTAINER_MEMORY}`,
    `--cpus=${CONTAINER_CPUS}`,
    ...buildVolumeArg(workspaceDir, isLocked),
    "--label", `${LOCK_LABEL}=${isLocked}`,
    "--security-opt", "no-new-privileges:true",
    CONTAINER_IMAGE,
    "sleep", "infinity",
  );
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  // Establish canonical ownership (workspace → developer) and re-apply any locked/crowned paths.
  // Safe to call here: the container is now running and we are NOT inside a dockerExec→ensureContainer
  // cycle (osLock spawns docker exec directly). No-op while globally locked (read-only mount).
  await reconcileOsPermissions(workspaceId);
}

export function ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
  // Coalesce concurrent calls: if a start is already in flight, piggyback on it.
  const inflight = startLocks.get(workspaceId);
  if (inflight) return inflight;

  const p = _ensureContainer(workspaceId, workspaceDir).finally(() => {
    startLocks.delete(workspaceId);
    resetIdleTimer(workspaceId);
  });
  startLocks.set(workspaceId, p);
  return p;
}

/**
 * Run a non-streaming command inside the workspace container via docker exec.
 * Ensures the container is running first (idempotent, resets idle timer).
 * cmdArgs are passed directly to execvp — no shell interpolation, so injection is impossible.
 * stdout is NOT trimmed so callers receive exact file content (trailing newlines preserved).
 */
export async function dockerExec(
  workspaceId: string,
  workspaceDir: string,
  cmdArgs: string[],
  opts: { stdin?: string; asAgent?: boolean } = {},
): Promise<DockerResult> {
  await ensureContainer(workspaceId, workspaceDir);
  const userArgs = opts.asAgent ? ["-u", "agent"] : [];
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["exec", "-i", ...userArgs, "-w", "/workspace", containerName(workspaceId), ...cmdArgs]);
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
      return;
    }
    proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdout!.on("error", () => {});
    proc.stderr!.on("error", () => {});
    proc.on("close", (code) => resolve({ stdout, stderr: stderr.trim(), code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
    if (opts.stdin !== undefined) {
      proc.stdin!.write(opts.stdin, () => proc.stdin!.end());
    } else {
      proc.stdin!.end();
    }
  });
}

export async function stopContainer(workspaceId: string): Promise<void> {
  const t = idleTimers.get(workspaceId);
  if (t) { clearTimeout(t); idleTimers.delete(workspaceId); }
  const r = await dockerCmd("stop", containerName(workspaceId));
  if (r.code !== 0) log.warn({ workspaceId, stderr: r.stderr }, "docker stop failed");
  await dockerCmd("network", "disconnect", networkName(workspaceId), containerName(workspaceId));
  const net = await dockerCmd("network", "rm", networkName(workspaceId));
  if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "network rm on stop (may not exist)");
}

export async function removeContainer(workspaceId: string): Promise<void> {
  const t = idleTimers.get(workspaceId);
  if (t) { clearTimeout(t); idleTimers.delete(workspaceId); }
  startLocks.delete(workspaceId);
  // Non-zero exit codes are expected if the container/network was never created.
  const stop = await dockerCmd("stop", containerName(workspaceId));
  if (stop.code !== 0) log.debug({ workspaceId, stderr: stop.stderr }, "docker stop on remove (may not exist)");
  const rm = await dockerCmd("rm", containerName(workspaceId));
  if (rm.code !== 0) log.debug({ workspaceId, stderr: rm.stderr }, "docker rm on remove (may not exist)");
  const net = await dockerCmd("network", "rm", networkName(workspaceId));
  if (net.code !== 0) log.debug({ workspaceId, stderr: net.stderr }, "docker network rm on remove (may not exist)");
}

// Deletes a workspace directory from the volume as root so that files created by the agent
// (which runs as root inside containers) can be removed even though the app runs as node (UID 1000).
// In production (WORKSPACES_VOLUME_NAME set) mounts the full volume and removes the subdir.
// In local dev falls back to a plain fs.rm since the app runs as the host user.
export async function deleteWorkspaceDir(workspaceDir: string): Promise<void> {
  if (WORKSPACES_VOLUME_NAME) {
    const workspaceName = path.basename(workspaceDir);
    const r = await dockerCmd("run", "--rm",
      "-v", `${WORKSPACES_VOLUME_NAME}:/data`,
      CONTAINER_IMAGE, "rm", "-rf", `/data/${workspaceName}`,
    );
    if (r.code !== 0) throw new Error(`failed to delete workspace dir: ${r.stderr}`);
  } else {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

export async function assertDockerAvailable(): Promise<void> {
  const r = await dockerCmd("info");
  if (r.code !== 0) {
    log.error({ stderr: r.stderr }, "Docker is not available. Make sure Docker is running before starting the server.");
    process.exit(1);
  }
  await ensureWorkspaceImage();
}

async function dockerfileHash(): Promise<string | null> {
  try {
    const content = await readFile("Dockerfile.workspace");
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function ensureWorkspaceImage(): Promise<void> {
  const hash = await dockerfileHash();
  const check = await dockerCmd("image", "inspect", CONTAINER_IMAGE);

  if (check.code === 0) {
    if (!hash) return; // can't read Dockerfile.workspace — assume image is current
    const label = await dockerCmd("image", "inspect", "--format", `{{index .Config.Labels "${HASH_LABEL}"}}`, CONTAINER_IMAGE);
    if (label.stdout === hash) return;
    log.info({ image: CONTAINER_IMAGE }, "Dockerfile.workspace changed — rebuilding workspace image (takes a few minutes)...");
  } else {
    log.info({ image: CONTAINER_IMAGE }, "workspace image not found — building now (takes a few minutes)...");
  }

  const buildArgs = ["build", "-f", "Dockerfile.workspace", "-t", CONTAINER_IMAGE];
  if (hash) buildArgs.push("--label", `${HASH_LABEL}=${hash}`);
  buildArgs.push(".");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("docker", buildArgs, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  log.info({ image: CONTAINER_IMAGE }, "workspace image ready");
}
