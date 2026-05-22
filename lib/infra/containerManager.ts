// Manages the Docker container lifecycle for each workspace.
// One container per workspace — created lazily on first execCommand, stopped after
// CONTAINER_IDLE_MS of inactivity, re-started automatically on next command.
//
// Container naming: ws_<workspaceId>
// Bind mount:       <workspaceDir> → /workspace  (host files, shared with file tools)
// Resource limits:  CONTAINER_MEMORY / CONTAINER_CPUS env vars (defaults: 1g / 1.0)
import { spawn } from "child_process";

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? "1.0";
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_MS ?? "", 10) || 10 * 60 * 1000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Prevents concurrent docker run/start calls for the same workspace.
const startLocks = new Map<string, Promise<void>>();

function containerName(workspaceId: string): string {
  return `ws_${workspaceId}`;
}

type DockerResult = { stdout: string; stderr: string; code: number };

function dockerCmd(...args: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("docker", args);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
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
    const r = await dockerCmd("start", containerName(workspaceId));
    if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
    return;
  }
  // missing — create and start
  const r = await dockerCmd(
    "run", "-d",
    "--name", containerName(workspaceId),
    `--memory=${CONTAINER_MEMORY}`,
    `--cpus=${CONTAINER_CPUS}`,
    "-v", `${workspaceDir}:/workspace`,
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
  await dockerCmd("stop", containerName(workspaceId));
}

export async function removeContainer(workspaceId: string): Promise<void> {
  const t = idleTimers.get(workspaceId);
  if (t) { clearTimeout(t); idleTimers.delete(workspaceId); }
  startLocks.delete(workspaceId);
  // Ignore errors — container may never have been created.
  await dockerCmd("stop", containerName(workspaceId));
  await dockerCmd("rm",   containerName(workspaceId));
}

export async function assertDockerAvailable(): Promise<void> {
  const r = await dockerCmd("info");
  if (r.code !== 0) {
    console.error("Docker is not available. Make sure Docker is running before starting the server.");
    console.error(r.stderr);
    process.exit(1);
  }
}
