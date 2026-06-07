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

// Builds the volume args for docker run.
// When WORKSPACES_VOLUME_NAME is set (production / Docker Compose), uses Docker 25+ volume
// subpath mounting — necessary because the Docker daemon sees host paths, not app-container
// paths, so a plain -v /app/data/<name>:/workspace would point at a non-existent host path.
// When unset (local dev, app runs directly on host), falls back to a plain bind mount using
// the resolved host path so local workspaces work without Docker Compose.
function buildVolumeArg(workspaceDir: string): string[] {
  if (!WORKSPACES_VOLUME_NAME) {
    return ["-v", `${workspaceDir}:/workspace`];
  }
  const workspaceName = path.basename(workspaceDir);
  return [
    "--mount",
    `type=volume,source=${WORKSPACES_VOLUME_NAME},target=/workspace,volume-subpath=${workspaceName}`,
  ];
}

// The container is labelled with the Dockerfile.workspace hash it was created from. When the image
// is rebuilt (new uid model, new tooling), this lets us detect stale containers and recreate them
// so the new image actually takes effect — otherwise a running container would be reused forever.
async function getContainerImageHash(workspaceId: string): Promise<string | null> {
  const r = await dockerCmd("inspect", "--format", `{{index .Config.Labels "${HASH_LABEL}"}}`, containerName(workspaceId));
  return r.code === 0 ? r.stdout : null;
}

async function _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
  const status = await getContainerStatus(workspaceId);
  const hash = await dockerfileHash();

  if (status === "running" || status === "stopped") {
    const containerHash = await getContainerImageHash(workspaceId);
    if (!hash || containerHash === hash) {
      if (status === "running") return;
      // stopped, image unchanged — just restart it
      log.debug({ workspaceId }, "starting stopped container");
      await ensureNetwork(workspaceId);
      const connect = await dockerCmd("network", "connect", networkName(workspaceId), containerName(workspaceId));
      if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
      const r = await dockerCmd("start", containerName(workspaceId));
      if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
      return;
    }
    // Image changed — remove so we recreate from the current image below.
    log.debug({ workspaceId }, "workspace image changed — recreating container");
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
    ...buildVolumeArg(workspaceDir),
    ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
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

  // One-time ownership sweep: legacy workspaces created when the agent ran as root hold root-owned
  // files the uid-1000 agent/app can no longer manage. Chown the tree to 1000:1000 so both can.
  // Runs as root (-u 0) for this single bootstrap command only; uses dockerCmd to avoid re-entering
  // ensureContainer. Idempotent and cheap on already-1000-owned trees.
  const chown = await dockerCmd("exec", "-u", "0", containerName(workspaceId), "chown", "-R", "1000:1000", "/workspace");
  if (chown.code !== 0) log.debug({ workspaceId, stderr: chown.stderr }, "workspace chown sweep failed (non-fatal)");
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
  opts: { stdin?: string } = {},
): Promise<DockerResult> {
  await ensureContainer(workspaceId, workspaceDir);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["exec", "-i", "-w", "/workspace", containerName(workspaceId), ...cmdArgs]);
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

// Runs a command inside the workspace container AS ROOT (-u 0). This is the single sanctioned root
// exec path for agent-facing functionality — used only by the `apt_install` tool to install system
// packages. cmdArgs are passed as argv (no shell), so callers must still validate untrusted input.
// The regular agent shell (dockerExec / execute_command) never runs as root.
export async function dockerExecAsRoot(
  workspaceId: string,
  workspaceDir: string,
  cmdArgs: string[],
): Promise<DockerResult> {
  await ensureContainer(workspaceId, workspaceDir);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["exec", "-u", "0", "-w", "/workspace", containerName(workspaceId), ...cmdArgs]);
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
      return;
    }
    proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdout!.on("error", () => {});
    proc.stderr!.on("error", () => {});
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
    proc.stdin!.end();
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

// Deletes a workspace directory from the volume. In production (WORKSPACES_VOLUME_NAME set) it
// mounts the full volume and removes the subdir as root (-u 0) — the agent now runs as uid 1000 so
// its files are normally removable directly, but a throwaway root rm also clears any legacy
// root-owned files left by workspaces created before the non-root migration.
// In local dev falls back to a plain fs.rm since the app runs as the host user.
export async function deleteWorkspaceDir(workspaceDir: string): Promise<void> {
  if (WORKSPACES_VOLUME_NAME) {
    const workspaceName = path.basename(workspaceDir);
    const r = await dockerCmd("run", "--rm", "-u", "0",
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
