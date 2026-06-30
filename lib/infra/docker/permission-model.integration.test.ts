// Integration tests for the agent permission model (needs Docker + the `paodo-workspace` image).
//
// These verify the KERNEL-level promises the model rests on — that a locked file cannot be written
// and a hidden file cannot be read by the agent identity, even though the agent has a full shell, and
// that the non-root `privd` identity (used for privileged scripts) can. They mirror the exact
// hardening flags containerManager applies. Run via `npm run test:integration`.
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Runs `setup` as root in a throwaway container (to lay down the on-disk state the reconcile would
// produce), then drops to `user` to run `test`. Mirrors containerManager's cap set + no-new-privileges
// so the kernel behaves exactly as in production. Avoid single quotes inside the snippets — they are
// embedded in `su <user> -c '...'`.
function asUser(setup: string, user: string, test: string): string {
  return execFileSync(
    "docker",
    [
      "run", "--rm", "-u", "0",
      "--cap-drop", "ALL",
      "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--cap-add", "FSETID", "--cap-add", "SETGID", "--cap-add", "SETUID",
      "--security-opt", "no-new-privileges:true",
      IMAGE,
      "bash", "-c", `set -e; ${setup}; su ${user} -c '${test}'`,
    ],
    { encoding: "utf8" },
  ).trim();
}

// Workspace root as the reconcile leaves it: non-agent-owned, setgid + sticky.
const ROOT = "chown node:paodo /workspace && chmod 3775 /workspace && cd /workspace";

describe.skipIf(!dockerAvailable())("agent permission model — kernel enforcement", () => {
  it("the default identity is the non-root agent (uid 1001), not the app/owner uid", () => {
    const uid = execFileSync("docker", ["run", "--rm", IMAGE, "id", "-u"], { encoding: "utf8" }).trim();
    expect(uid).toBe("1001");
  });

  it("agent CAN read but CANNOT write a locked file", () => {
    const setup = `${ROOT} && echo secret > f.txt && chown privd:privd f.txt && chmod 0644 f.txt`;
    expect(asUser(setup, "agent", "cat /workspace/f.txt")).toBe("secret");
    expect(asUser(setup, "agent", "echo x > /workspace/f.txt 2>/dev/null && echo WROTE || echo BLOCKED")).toBe("BLOCKED");
  });

  it("agent CANNOT read a hidden file (content), even with a shell", () => {
    const setup = `${ROOT} && echo topsecret > h.txt && chown privd:privd h.txt && chmod 0600 h.txt`;
    expect(asUser(setup, "agent", "cat /workspace/h.txt 2>/dev/null && echo READ || echo BLOCKED")).toBe("BLOCKED");
    // The name is still listable — only content is protected.
    expect(asUser(setup, "agent", "ls /workspace/h.txt")).toBe("/workspace/h.txt");
  });

  it("agent CANNOT delete a locked file (sticky bit on a non-agent-owned dir)", () => {
    const setup = `${ROOT} && echo data > f.txt && chown privd:privd f.txt && chmod 0644 f.txt`;
    const out = asUser(setup, "agent", "rm -f /workspace/f.txt 2>/dev/null; test -e /workspace/f.txt && echo KEPT || echo GONE");
    expect(out).toBe("KEPT");
  });

  it("privd CAN read a hidden file and write a locked file (privileged-script identity)", () => {
    const hidden = `${ROOT} && echo topsecret > h.txt && chown privd:privd h.txt && chmod 0600 h.txt`;
    expect(asUser(hidden, "privd", "cat /workspace/h.txt")).toBe("topsecret");
    const locked = `${ROOT} && echo data > f.txt && chown privd:privd f.txt && chmod 0644 f.txt`;
    expect(asUser(locked, "privd", "echo y > /workspace/f.txt && cat /workspace/f.txt")).toBe("y");
  });

  it("agent CAN still create and delete its OWN files in the workspace", () => {
    expect(asUser(ROOT, "agent", "echo hi > /workspace/mine.txt && rm /workspace/mine.txt && echo OK")).toBe("OK");
  });
});
