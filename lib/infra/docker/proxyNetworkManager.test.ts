// ProxyNetworkManager has had no direct coverage — it was only exercised indirectly through
// containerManager.proxy.test.ts's ensure() flow. These pin it in isolation: attach/detach/verify's
// self-heal and loud-failure behavior, and reattachAll's shouldAttach filter (which excludes
// internet-access-off workspaces from the boot-time reattach — reattaching the sidecar to one of
// those would hand its network a live route back to the internet).
import { describe, it, expect } from "vitest";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };
const SIDECAR = "paodo_ws_credproxy";

const { ProxyNetworkManager } = await import("./proxyNetworkManager");

function makeDocker(handler?: (args: string[]) => DockerResult | undefined) {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      return handler?.(args) ?? OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

describe("ProxyNetworkManager.attach", () => {
  it("connects the sidecar with the credproxy alias", async () => {
    const { docker, calls } = makeDocker();
    await new ProxyNetworkManager(docker).attach("ws1");
    expect(calls).toContainEqual(["network", "connect", "--alias", "credproxy", "wsnet_ws1", SIDECAR]);
  });

  it("treats 'already connected' as success, not a warning-worthy failure", async () => {
    const { docker } = makeDocker((args) =>
      args[1] === "connect" ? { stdout: "", stderr: "already connected", code: 1 } : undefined,
    );
    await expect(new ProxyNetworkManager(docker).attach("ws1")).resolves.toBeUndefined();
  });
});

describe("ProxyNetworkManager.detach", () => {
  it("force-disconnects the sidecar from the workspace network", async () => {
    const { docker, calls } = makeDocker();
    await new ProxyNetworkManager(docker).detach("ws1");
    expect(calls).toContainEqual(["network", "disconnect", "-f", "wsnet_ws1", SIDECAR]);
  });
});

describe("ProxyNetworkManager.verify", () => {
  it("no-ops when the sidecar is already attached", async () => {
    const { docker, calls } = makeDocker((args) =>
      args[1] === "inspect" ? { stdout: `${SIDECAR} `, stderr: "", code: 0 } : undefined,
    );
    await new ProxyNetworkManager(docker).verify("ws1");
    expect(calls.some((c) => c[1] === "connect")).toBe(false);
  });

  it("self-heals by reattaching when the sidecar is missing", async () => {
    let attached = false;
    const { docker } = makeDocker((args) => {
      if (args[1] === "inspect") return { stdout: attached ? `${SIDECAR} ` : "", stderr: "", code: 0 };
      if (args[1] === "connect") {
        attached = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return undefined;
    });
    await expect(new ProxyNetworkManager(docker).verify("ws1")).resolves.toBeUndefined();
  });

  it("throws when reattachment doesn't stick", async () => {
    const { docker } = makeDocker((args) => (args[1] === "inspect" ? { stdout: "", stderr: "", code: 0 } : undefined));
    await expect(new ProxyNetworkManager(docker).verify("ws1")).rejects.toThrow(/not attached/);
  });
});

describe("ProxyNetworkManager.reattachAll", () => {
  it("attaches every running workspace container when no filter is given", async () => {
    const { docker, calls } = makeDocker((args) =>
      args[0] === "ps" ? { stdout: "ws_a\nws_b\n", stderr: "", code: 0 } : undefined,
    );
    await new ProxyNetworkManager(docker).reattachAll();
    const connects = calls.filter((c) => c[1] === "connect").map((c) => c[4]);
    expect(connects.sort()).toEqual(["wsnet_a", "wsnet_b"]);
  });

  it("excludes a workspace the shouldAttach filter rejects (internet-access off)", async () => {
    const { docker, calls } = makeDocker((args) =>
      args[0] === "ps" ? { stdout: "ws_a\nws_off\n", stderr: "", code: 0 } : undefined,
    );
    await new ProxyNetworkManager(docker).reattachAll((id) => id !== "off");
    const connects = calls.filter((c) => c[1] === "connect").map((c) => c[4]);
    expect(connects).toEqual(["wsnet_a"]);
  });

  it("does nothing when docker ps fails", async () => {
    const { docker, calls } = makeDocker((args) =>
      args[0] === "ps" ? { stdout: "", stderr: "boom", code: 1 } : undefined,
    );
    await new ProxyNetworkManager(docker).reattachAll();
    expect(calls.some((c) => c[1] === "connect")).toBe(false);
  });
});
