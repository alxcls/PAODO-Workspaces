// Unit tests for ContainerManager — focuses on the in-flight / eager-flip machinery.
// Uses a fake IDockerClient so no real Docker is needed.
import { describe, it, expect, vi, beforeAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// Must be set before agentPermissionStore is imported (it reads WORKSPACES_ROOT at eval time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm-test-"));
process.env.WORKSPACES_ROOT = TMP;
process.env.WORKSPACES_VOLUME_NAME = ""; // bind-mount mode — no volume subpath logic

// Imported after env var is set.
let ContainerManager: typeof import("./containerManager").ContainerManager;
beforeAll(async () => {
  ({ ContainerManager } = await import("./containerManager"));
});

const WS = "test-ws";
const DIR = path.join(TMP, WS);
fs.mkdirSync(DIR, { recursive: true });

// ok() / fail() produce minimal DockerResult-shaped values.
const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 as const });
const fail = (stderr = "") => ({ stdout: "", stderr, code: 1 as const });

// Build a minimal fake IDockerClient. Any unhandled subcommand returns ok("").
function makeDocker(handlers: Record<string, (...args: string[]) => { stdout: string; stderr: string; code: number }>) {
  const calls: string[][] = [];
  return {
    calls,
    async cmd(...args: string[]) {
      calls.push(args);
      return handlers[args[0]]?.(...args) ?? ok();
    },
    async exec() { return ok(); },
    async build() {},
  };
}

// A fake where the container is already RUNNING and the perms label matches (no recreate needed).
// "none" is mountPolicyHash()'s value when no restrictions are set, which is the case for WS here.
function idleFake() {
  return makeDocker({
    inspect: (...args) => {
      if (args.includes("{{.State.Status}}")) return ok("running");
      if (args.join(" ").includes("paodo.perms-hash")) return ok("none"); // matches fresh workspace
      return ok("");     // getContainerImageHash → empty (hash=null → hashChanged=false)
    },
    image: () => fail(),  // no snapshot image
    port: () => ok("0.0.0.0:54321->8080/tcp"),
  });
}

describe("ContainerManager in-flight tracking", () => {
  it("drains to zero after exec completes", async () => {
    const docker = idleFake();
    const mgr = new ContainerManager(docker as never);
    await mgr.exec(WS, DIR, ["echo", "hi"]);
    const inflight = (mgr as unknown as { inflight: Map<string, number> }).inflight;
    expect(inflight.get(WS)).toBeUndefined();
  });

  it("drains to zero even when exec throws", async () => {
    const docker = makeDocker({
      inspect: () => fail(),  // container missing → tries to create
      image: () => fail(),    // no snapshot
      network: () => ok(),
      run: () => fail("boom"), // docker run fails
    });
    const mgr = new ContainerManager(docker as never);
    await expect(mgr.exec(WS, DIR, ["echo", "hi"])).rejects.toThrow();
    const inflight = (mgr as unknown as { inflight: Map<string, number> }).inflight;
    expect(inflight.get(WS)).toBeUndefined();
  });
});

describe("ContainerManager.requestFlip", () => {
  it("returns early for a stopped/missing container", async () => {
    const docker = makeDocker({
      inspect: () => fail(), // missing
    });
    const mgr = new ContainerManager(docker as never);
    const priv = mgr as unknown as { flip: (id: string, dir: string) => Promise<void> };
    const flipSpy = vi.spyOn(priv, "flip");
    await mgr.requestFlip(WS, DIR);
    expect(flipSpy).not.toHaveBeenCalled();
  });

  it("fires flip immediately when no command is in flight", async () => {
    const docker = idleFake();
    const mgr = new ContainerManager(docker as never);
    const priv = mgr as unknown as { flip: (id: string, dir: string) => Promise<void> };
    const flipSpy = vi.spyOn(priv, "flip");
    await mgr.requestFlip(WS, DIR);
    // requestFlip calls `void flip(...)` — it schedules but doesn't await it. Give the
    // microtask queue one turn to enqueue the void promise.
    await Promise.resolve();
    expect(flipSpy).toHaveBeenCalledWith(WS, DIR);
  });

  it("defers flip and parks it in flipPending when a command is in flight", async () => {
    const docker = idleFake();
    const mgr = new ContainerManager(docker as never);
    const priv = mgr as unknown as {
      inflight: Map<string, number>;
      flipPending: Map<string, string>;
    };
    // Simulate a running command.
    priv.inflight.set(WS, 1);
    await mgr.requestFlip(WS, DIR);
    expect(priv.flipPending.get(WS)).toBe(DIR);
  });

  it("fires deferred flip when the last in-flight command completes", async () => {
    const docker = idleFake();
    const mgr = new ContainerManager(docker as never);
    const priv = mgr as unknown as {
      inflight: Map<string, number>;
      flipPending: Map<string, string>;
      flip: (id: string, dir: string) => Promise<void>;
      decInflight: (id: string) => void;
    };
    const flipSpy = vi.spyOn(priv, "flip");

    // Park a deferred flip.
    priv.flipPending.set(WS, DIR);
    // Simulate one in-flight command draining to zero.
    priv.inflight.set(WS, 1);
    priv.decInflight(WS);

    // decInflight fires `void this.flip(...)` — flush the microtask.
    await Promise.resolve();
    expect(flipSpy).toHaveBeenCalledWith(WS, DIR);
    expect(priv.flipPending.get(WS)).toBeUndefined();
  });

  it("does NOT fire deferred flip when count drains to a positive value (concurrent commands)", async () => {
    const docker = idleFake();
    const mgr = new ContainerManager(docker as never);
    const priv = mgr as unknown as {
      inflight: Map<string, number>;
      flipPending: Map<string, string>;
      flip: (id: string, dir: string) => Promise<void>;
      decInflight: (id: string) => void;
    };
    const flipSpy = vi.spyOn(priv, "flip");

    priv.flipPending.set(WS, DIR);
    priv.inflight.set(WS, 2); // two commands running

    priv.decInflight(WS); // drops to 1 — should NOT fire flip yet
    await Promise.resolve();

    expect(flipSpy).not.toHaveBeenCalled();
    expect(priv.flipPending.get(WS)).toBe(DIR); // still pending
    expect(priv.inflight.get(WS)).toBe(1);
  });
});
