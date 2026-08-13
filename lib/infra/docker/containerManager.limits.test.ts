// Resource caps are applied at `docker run` and can never be added later — the workspace container
// is stateful and is never recreated, so a container born without a cap keeps running without one
// for its whole life. That makes these flags a create-time-only guarantee worth pinning.
//
// --pids-limit is the load-bearing one: Docker defaults to unlimited, and without it a fork bomb in
// any single workspace exhausts the host's global pid_max, at which point nothing on the host can
// fork — including the `docker exec` this app spawns for every command. One workspace would take
// down every other workspace and the app with it.
import { describe, it, expect } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Nothing exists yet, so ensure() takes the full create path and issues `run`.
function makeDocker() {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "", stderr: "no such network", code: 1 };
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

async function runArgs(): Promise<string[]> {
  const { docker, calls } = makeDocker();
  await new ContainerManager(docker).ensure("ws1", "/w");
  return calls.find((c) => c[0] === "run")!;
}

describe("ContainerManager — workspace container resource caps", () => {
  it("caps the process count so a fork bomb cannot exhaust the host's PIDs", async () => {
    expect(await runArgs()).toContain("--pids-limit=512");
  });

  it("caps memory and CPU", async () => {
    const args = await runArgs();
    expect(args).toContain("--memory=1g");
    expect(args).toContain("--cpus=1.0");
  });
});
