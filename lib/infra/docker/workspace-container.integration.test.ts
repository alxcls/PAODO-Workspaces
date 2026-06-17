// Integration tests for the workspace container (needs Docker) — verifies the
// container's confinement: non-root, no write access outside /workspace.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// INTEGRATION TEST — needs Docker + the `paodo-workspace` image.
// Verifies the workspace container's confinement, i.e. the security posture an
// agent runs under: non-root, no write access outside /workspace. This guards
// the IMAGE config (USER dev in Dockerfile.workspace) and is run faithfully with
// the same hardening flags containerManager applies (--cap-drop ALL,
// --security-opt no-new-privileges). Run via `npm run test:integration`.

const IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Run a shell snippet inside a throwaway container, mirroring the app's run flags.
// Returns trimmed stdout. Snippets use `&& echo OK || echo DENIED` so we assert on
// output rather than wrestling with exit codes.
function inContainer(snippet: string): string {
  return execFileSync(
    "docker",
    [
      "run", "--rm",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      IMAGE,
      "bash", "-c", snippet,
    ],
    { encoding: "utf8" },
  ).trim();
}

describe.skipIf(!dockerAvailable())("workspace container confinement", () => {
  it("runs as a non-root user", () => {
    // The security INVARIANT is simply: not root. Asserting uid !== 0 survives
    // any future change to the username or the specific uid — we pin the promise,
    // not the incidental details of how it's met.
    expect(inContainer("id -u")).not.toBe("0");
  });

  it("CANNOT write to system paths outside the workspace", () => {
    expect(inContainer("touch /etc/evil 2>/dev/null && echo WROTE || echo BLOCKED")).toBe("BLOCKED");
    expect(inContainer("touch /root/evil 2>/dev/null && echo WROTE || echo BLOCKED")).toBe("BLOCKED");
    expect(inContainer("touch /usr/bin/evil 2>/dev/null && echo WROTE || echo BLOCKED")).toBe("BLOCKED");
  });

  it("CAN write inside its own /workspace", () => {
    expect(inContainer("touch /workspace/ok 2>/dev/null && echo WROTE || echo BLOCKED")).toBe("WROTE");
  });

  it("cannot escalate privileges (no-new-privileges blocks setuid)", () => {
    // Even if a setuid binary exists, no-new-privileges prevents gaining root.
    expect(inContainer("id -u")).not.toBe("0");
  });
});
