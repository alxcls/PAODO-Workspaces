// Manages the lifecycle of the workspace Docker image: detects Dockerfile changes via
// a content hash label and rebuilds the image when a change is detected.
// Separated from ContainerManager so container lifecycle and image build concerns don't mix.
import { readFile } from "fs/promises";
import { hashDockerfile } from "./dockerfileHasher";
import { createLogger } from "../logger";
import type { IDockerClient } from "./dockerClient";

const log = createLogger("imageManager");

export const HASH_LABEL = "paodo.workspace-hash";

export class ImageManager {
  constructor(private readonly docker: IDockerClient) {}

  // Ensures the named image exists and is up-to-date with the given Dockerfile.
  // Rebuilds if the image is missing or its hash label doesn't match the current file.
  async ensureImage(imageName: string, dockerfilePath: string): Promise<void> {
    const hash = await hashDockerfile(dockerfilePath);
    const check = await this.docker.cmd("image", "inspect", imageName);

    if (check.code === 0) {
      if (!hash) return; // can't read Dockerfile — assume image is current
      const label = await this.docker.cmd(
        "image",
        "inspect",
        "--format",
        `{{index .Config.Labels "${HASH_LABEL}"}}`,
        imageName,
      );
      if (label.stdout === hash) return;
      log.info({ image: imageName }, "Dockerfile changed — rebuilding workspace image (takes a few minutes)...");
    } else {
      log.info({ image: imageName }, "workspace image not found — building now (takes a few minutes)...");
    }

    // Pipe the Dockerfile on stdin with an empty build context ("-") to avoid tarring
    // the mounted /app/data volume, which may contain files unreadable by the app user.
    const dockerfile = await readFile(dockerfilePath);
    const buildArgs = ["build", "-t", imageName];
    if (hash) buildArgs.push("--label", `${HASH_LABEL}=${hash}`);
    buildArgs.push("-");

    await this.docker.build(buildArgs, dockerfile);
    log.info({ image: imageName }, "workspace image ready");
  }

  // Returns the hash label from an existing container, or null if not present.
  async getContainerImageHash(containerName: string): Promise<string | null> {
    const r = await this.docker.cmd("inspect", "--format", `{{index .Config.Labels "${HASH_LABEL}"}}`, containerName);
    return r.code === 0 ? r.stdout : null;
  }

  // Returns the current Dockerfile hash without building anything.
  async getCurrentHash(dockerfilePath: string): Promise<string | null> {
    return hashDockerfile(dockerfilePath);
  }
}
