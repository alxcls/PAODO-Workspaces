// Injection smoke check — proves the DIP refactor's payoff without any test framework.
// Run: npx tsx dev_tools/check/inject-smoke.ts
//
// It constructs an isolated WorkspaceStore (fresh Map, no-op persistence) and a hand-written
// fake IContainerManager, wires them through setServices() + the agent tool seam, and asserts:
//   1. getStore()/getContainers() return the injected fakes (route-layer seam works).
//   2. A real file tool (FileReadTool) runs against the fake container — ZERO Docker spawned.
//   3. The production global store is untouched — ZERO shared/global state leakage.
// When a test framework is later chosen, this ports directly into a real test.
import { WorkspaceStore, defaultWorkspaceStore } from "../../lib/infra/workspace/registry";
import type { Workspace } from "../../lib/workspace/types";
import { getStore, getContainers, setServices, resetServices } from "../../lib/infra/services";
import type { IContainerManager } from "../../lib/infra/interfaces";
import type { DockerResult } from "../../lib/infra/docker/dockerClient";
import { FileReadTool } from "../../lib/agent/tools/fileRead";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// --- Fake container manager: records calls, never touches Docker ---
const execCalls: string[][] = [];
const ok = (stdout: string): DockerResult => ({ stdout, stderr: "", code: 0 });
const fakeContainers: IContainerManager = {
  ensure: async () => {},
  exec: async (_id, _dir, cmd) => {
    execCalls.push(cmd);
    return ok("hello from fake container\n");
  },
  execStreaming: async () => ({ code: 0 }),
  execAsRoot: async () => ok(""),
  openOutputSink: (_id, runId) => ({
    path: `/tmp/paodo-exec/${runId}.output`,
    limit: 50 * 1024 * 1024,
    truncated: false,
    write: () => {},
    close: () => {},
  }),
  startBackground: async () => ({ taskId: "fake-task", logFile: "/tmp/paodo-tasks/fake-task.output" }),
  stopBackground: async () => false,
  listBackground: () => [],
  reconcileBackgroundTasks: async () => [],
  stop: async () => {},
  remove: async () => {},
  applyInternetAccess: async () => {},
  reattachProxyNetworks: async () => {},
  resumeIdleReapers: async () => {},
  noteRunStart: () => {},
  noteRunEnd: () => {},
  deleteWorkspaceDir: async () => {},
  assertDockerAvailable: async () => {},
};

async function main(): Promise<void> {
  // --- Isolated store: fresh map, no disk persistence, one pre-seeded workspace ---
  const wsId = "smoke-ws-id";
  const ws: Workspace = {
    id: wsId,
    name: "smoke-ws",
    dir: "/tmp/smoke-ws",
    createdAt: new Date(),
    maxIterations: 30,
    maxRunMinutes: 5,
    internetAccess: true,
  };
  const isolatedStore = new WorkspaceStore({
    map: new Map([[wsId, ws]]),
    persist: () => {},
  });

  setServices({ store: isolatedStore, containers: fakeContainers });
  try {
    console.log("1. Service accessors return the injected fakes");
    assert(getStore() === isolatedStore, "getStore() is the isolated store");
    assert(getContainers() === fakeContainers, "getContainers() is the fake container manager");
    assert(getStore().getWorkspace(wsId)?.name === "smoke-ws", "isolated store resolves the seeded workspace");

    console.log("2. A real file tool runs against the fake container (no Docker)");
    // Mirror how buildTools derives an ExecRunner from the container manager.
    const tool = new FileReadTool({
      exec: (cmd, opts) => fakeContainers.exec(wsId, ws.dir, cmd, opts),
    });
    const result = await tool.invoke({ file_path: "greeting.txt" });
    assert(execCalls.length === 1, "exactly one container exec was issued");
    assert(execCalls[0]?.[0] === "cat", "the tool issued a `cat` via the fake (not Docker)");
    assert(result.includes("hello from fake container"), "tool returned the fake's canned output");

    console.log("3. Production global state is untouched");
    assert(
      defaultWorkspaceStore.getWorkspace(wsId) === undefined,
      "default global store never saw the smoke workspace",
    );
  } finally {
    resetServices();
  }

  assert(getStore() === defaultWorkspaceStore, "resetServices() restored the production store");

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS: injection seam works — no Docker, no global state.");
}

main().catch((err) => {
  console.error("injection smoke threw:", err);
  process.exit(1);
});
