import { readFile } from "fs/promises";
import { createHash } from "crypto";

export async function hashDockerfile(dockerfilePath: string): Promise<string | null> {
  try {
    const content = await readFile(dockerfilePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
