// Manages the Docker container lifecycle for each workspace.
// One container per workspace — created lazily on first execCommand, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Network naming:   wsnet_<workspaceId>  (isolated per-workspace bridge — no inter-container traffic)
// Bind mount:       <workspaceDir> → /workspace  (host files, shared with file tools)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS env vars (defaults: 1g / 1.0)
import { spawn } from "child_process";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { createLogger } from "./logger";

const log = createLogger("container");

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const HASH_LABEL = "paodo.workspace-hash";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;

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

type DockerResult = { stdout: string; stderr: string; code: number };

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

async function _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
  const status = await getContainerStatus(workspaceId);
  if (status === "running") return;
  if (status === "stopped") {
    log.debug({ workspaceId }, "starting stopped container");
    await ensureNetwork(workspaceId);
    const connect = await dockerCmd("network", "connect", networkName(workspaceId), containerName(workspaceId));
    if (connect.code !== 0) throw new Error(`docker network connect failed: ${connect.stderr}`);
    const r = await dockerCmd("start", containerName(workspaceId));
    if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
    return;
  }
  // missing — create and start
  log.debug({ workspaceId }, "creating container");
  await ensureNetwork(workspaceId);
  const r = await dockerCmd(
    "run", "-d",
    "--name", containerName(workspaceId),
    "--network", networkName(workspaceId),
    `--memory=${CONTAINER_MEMORY}`,
    `--cpus=${CONTAINER_CPUS}`,
    "-v", `${workspaceDir}:/workspace`,
    "--security-opt", "no-new-privileges:true",
    CONTAINER_IMAGE,
    "sleep", "infinity",
  );
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
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
