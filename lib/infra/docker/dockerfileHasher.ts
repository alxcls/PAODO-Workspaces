// Hashes the Dockerfile content so ContainerManager can detect when the image is stale and needs a rebuild.
import { readFile } from "fs/promises";
import { createHash } from "crypto";
import { createLogger } from "../logger";

const log = createLogger("container");
const failedPaths = new Set<string>();

export async function hashDockerfile(dockerfilePath: string): Promise<string | null> {
  try {
    const content = await readFile(dockerfilePath);
    failedPaths.delete(dockerfilePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch (err) {
    // This function runs on every container wake. Log a persistent failure once, then stay quiet
    // until a successful read resets it, so a missing Dockerfile cannot flood the durable log.
    if (!failedPaths.has(dockerfilePath)) {
      failedPaths.add(dockerfilePath);
      log.warn({ err, dockerfilePath }, "failed to hash workspace Dockerfile — image freshness unavailable");
    }
    return null;
  }
}
