// Finds a free host port (by binding to :0 and releasing) and checks whether a workspace container already has a port mapped.
import { createServer } from "net";
import type { IDockerClient } from "./dockerClient";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const _portMap = new Map<string, number>();

export function cachePort(workspaceId: string, port: number): void {
  _portMap.set(workspaceId, port);
}

export function getCachedPort(workspaceId: string): number | undefined {
  return _portMap.get(workspaceId);
}

export function invalidatePort(workspaceId: string): void {
  _portMap.delete(workspaceId);
}

export async function queryDockerPort(
  containerName: string,
  docker: IDockerClient,
): Promise<number | null> {
  const r = await docker.cmd("port", containerName, "8080");
  if (r.code !== 0 || !r.stdout) return null;
  // Output format: "0.0.0.0:PORT" or ":::PORT"
  const match = r.stdout.match(/:(\d+)$/m);
  if (!match) return null;
  return parseInt(match[1], 10);
}
