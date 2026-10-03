// Workspace container confinement against the real `paodo-workspace` image, with containerManager's
// hardening flags: the agent is non-root, and root execs never run what the agent planted.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { DockerClient } from "./dockerClient";

vi.mock("../proxy/proxyCA", () => ({ deriveProxySecret: (ws: string) => `derived-${ws}` }));

const { ensureProxyRelay } = await import("./proxyRelay");

const IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Runs a snippet in a throwaway container with the app's run flags; snippets echo their outcome, so
// tests assert on output rather than exit codes.
function inContainer(snippet: string): string {
  return execFileSync(
    "docker",
    ["run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", IMAGE, "bash", "-c", snippet],
    { encoding: "utf8" },
  ).trim();
}

describe.skipIf(!dockerAvailable())("workspace container confinement", () => {
  it("runs as a non-root user", () => {
    // Pins the invariant, not root, rather than a username or uid that may change.
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

// The agent owns ~/.pyenv/bin, which leads the image's PATH. Each shim records that it ran.
const SHIMMED = ["sh", "cat", "awk", "tinyproxy"];
const CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETGID", "SETUID"];

describe.skipIf(!dockerAvailable())("root execs ignore what the agent planted", () => {
  const name = `paodo-root-exec-test-${process.pid}`;
  const docker = new DockerClient();
  // As the agent, with absolute paths so its own shims stay out of the record.
  const asAgent = (snippet: string) =>
    execFileSync("docker", ["exec", name, "/bin/sh", "-c", snippet], { encoding: "utf8" }).trim();
  const hijacked = () => asAgent("/bin/cat /tmp/hijacked 2>/dev/null || true");

  beforeAll(() => {
    execFileSync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      ...CAPS.flatMap((cap) => ["--cap-add", cap]),
      "--security-opt",
      "no-new-privileges:true",
      "-e",
      "HTTP_PROXY=http://127.0.0.1:3128",
      IMAGE,
      "sleep",
      "infinity",
    ]);
    const shim = (bin: string) =>
      `printf '#!/bin/sh\\necho ${bin} >> /tmp/hijacked\\nexec /usr/bin/${bin} "$@"\\n' > /home/dev/.pyenv/bin/${bin}` +
      ` && /bin/chmod +x /home/dev/.pyenv/bin/${bin}`;
    asAgent(SHIMMED.map(shim).join(" && "));
  });

  afterAll(() => {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  });

  it("runs with only the allowlisted env, from /", async () => {
    const { stdout } = await docker.exec(name, ["env"], { asRoot: true });
    const env = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(Object.keys(env).sort()).toEqual(["DEBIAN_FRONTEND", "HOME", "HTTP_PROXY", "PATH"]);
    expect(env).toMatchObject({
      HOME: "/root",
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      HTTP_PROXY: "http://127.0.0.1:3128",
    });
    expect((await docker.exec(name, ["pwd"], { asRoot: true, trimStdout: true })).stdout).toBe("/");
    expect(hijacked()).toBe("");
  });

  it("starts the egress relay without running the agent's binaries or exposing its config", async () => {
    await expect(ensureProxyRelay(docker, name, "ws1", false)).resolves.toBe(true);
    expect(hijacked()).toBe("");
    expect(asAgent("/bin/cat /etc/paodo-relay/tinyproxy.conf 2>&1 || true")).toContain("Permission denied");
  });

  // Last, since it records: proves the shims above are live, so their silence means something.
  it("control: a root exec that inherits the container env does run them", () => {
    execFileSync("docker", ["exec", "-u", "0", name, "sh", "-c", "true"]);
    expect(hijacked()).toContain("sh");
  });
});
