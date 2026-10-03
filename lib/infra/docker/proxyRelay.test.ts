// The relay is the workspace's route out, so a failure here must degrade to the container's own
// proxy settings rather than reject, and the install must never wait on the relay it installs.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { DockerResult, IDockerClient } from "./dockerClient";
import { PROXY_RELAY_INSTALL_TIMEOUT_MS } from "../limits";

vi.mock("../proxy/proxyCA", () => ({ deriveProxySecret: (ws: string) => `derived-${ws}` }));

const { buildRelayConfig, ensureProxyRelay, RELAY_PROXY_URL } = await import("./proxyRelay");

const result = (code: number, stderr = ""): DockerResult => ({ stdout: "", stderr, code });
const isInstall = (argv: string[]) => argv.join(" ").includes("apt-get install");

// Each start returns the next code in `starts`; installs return `install` (or hang when "hang").
function makeDocker(starts: number[], install: number | "hang" = 0) {
  const calls: { argv: string[]; opts?: Parameters<IDockerClient["exec"]>[2] }[] = [];
  const docker = {
    cmd: vi.fn(),
    build: vi.fn(),
    exec: vi.fn(async (_name: string, argv: string[], opts?: Parameters<IDockerClient["exec"]>[2]) => {
      calls.push({ argv, opts });
      if (isInstall(argv)) return install === "hang" ? new Promise<DockerResult>(() => {}) : result(install);
      return result(starts.shift() ?? 0, "tinyproxy: Could not create listening sockets.");
    }),
  } as unknown as IDockerClient;
  return { docker, calls, installs: () => calls.filter((c) => isInstall(c.argv)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildRelayConfig", () => {
  const config = buildRelayConfig("ws1");

  it("listens on loopback only", () => {
    expect(config).toMatch(/^Listen 127\.0\.0\.1$/m);
    expect(config).toMatch(/^Allow 127\.0\.0\.1$/m);
    expect(RELAY_PROXY_URL).toBe("http://127.0.0.1:3128");
  });

  it("forwards to the credential proxy with the workspace's verifiable identity", () => {
    expect(config).toMatch(/^Upstream http ws1:derived-ws1@credproxy:9998$/m);
  });

  it("outlasts tinyproxy's 600s idle default, so long streams survive", () => {
    expect(Number(/^Timeout (\d+)$/m.exec(config)?.[1])).toBeGreaterThan(600);
  });
});

describe("ensureProxyRelay", () => {
  it("starts the relay as root with its config on stdin, never on the command line", async () => {
    const { docker, calls } = makeDocker([0]);
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", true)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ asRoot: true, stdin: buildRelayConfig("ws1") });
    expect(calls[0].argv.join(" ")).not.toContain("derived-ws1");
  });

  it("installs the relay into an older container, then starts it", async () => {
    const { docker, calls, installs } = makeDocker([3, 0]);
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", true)).resolves.toBe(true);
    expect(installs()).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("installs through the credential proxy directly, not through the relay it is installing", async () => {
    const { docker, installs } = makeDocker([3, 0]);
    await ensureProxyRelay(docker, "ws_1", "ws1", true);
    const { opts } = installs()[0];
    expect(opts).toMatchObject({ asRoot: true });
    expect(opts?.env?.http_proxy).toBe("http://ws1:derived-ws1@credproxy:9998");
    expect(opts?.env?.https_proxy).toBe(opts?.env?.http_proxy);
  });

  it("does not install without internet access", async () => {
    const { docker, installs } = makeDocker([3]);
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", false)).resolves.toBe(false);
    expect(installs()).toHaveLength(0);
  });

  it("reports not ready when the install fails", async () => {
    const { docker, calls } = makeDocker([3], 100);
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", true)).resolves.toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("gives up on an install that never answers, so the wake is not held hostage", async () => {
    vi.useFakeTimers();
    const { docker } = makeDocker([3], "hang");
    const outcome = ensureProxyRelay(docker, "ws_1", "ws1", true);
    await vi.advanceTimersByTimeAsync(PROXY_RELAY_INSTALL_TIMEOUT_MS);
    await expect(outcome).resolves.toBe(false);
  });

  it("reports not ready when the relay does not come up", async () => {
    const { docker } = makeDocker([1]);
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", true)).resolves.toBe(false);
  });

  it("never rejects, even when docker itself fails", async () => {
    const docker = { exec: vi.fn().mockRejectedValue(new Error("daemon gone")) } as unknown as IDockerClient;
    await expect(ensureProxyRelay(docker, "ws_1", "ws1", true)).resolves.toBe(false);
  });
});
