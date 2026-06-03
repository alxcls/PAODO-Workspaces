// Server-mediated apt broker for workspace containers.
// The agent calls install_system_package; this module runs `apt-get install` as root
// via runRoot (docker exec -u root) and re-asserts /workspace ownership afterward.
// Calls are serialized per container because dpkg holds a global lock.
import { runRoot, reconcileOsPermissions } from "./osLock";
import { createLogger } from "./logger";

const log = createLogger("aptBroker");

// Valid apt package name: starts with alphanumeric, followed by alphanumeric/.+- chars.
const PKG_RE = /^[a-z0-9][a-z0-9.+\-]*$/i;

// Per-workspace promise chain — ensures serial apt execution within each container.
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(workspaceId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  queues.set(workspaceId, next.catch(() => {}));
  return next;
}

export interface AptInstallResult {
  installed: string[];
  stdout: string;
  stderr: string;
  code: number;
}

export async function aptInstall(workspaceId: string, packages: string[]): Promise<AptInstallResult> {
  const invalid = packages.filter((p) => !PKG_RE.test(p));
  if (invalid.length > 0) {
    return { installed: [], stdout: "", stderr: `Invalid package name(s): ${invalid.join(", ")}`, code: 1 };
  }

  return serialize(workspaceId, async () => {
    log.info({ workspaceId, packages }, "apt install");

    // Update index first so newly-released packages are visible.
    const update = await runRoot(workspaceId, [
      "env", "DEBIAN_FRONTEND=noninteractive",
      "apt-get", "update", "-qq",
    ]);
    if (update.code !== 0) {
      log.warn({ workspaceId, stderr: update.stderr }, "apt-get update failed");
    }

    const install = await runRoot(workspaceId, [
      "env", "DEBIAN_FRONTEND=noninteractive",
      "apt-get", "install", "-y", ...packages,
    ]);

    // Always reconcile so apt maintainer scripts can't leave /workspace in a broken state.
    await reconcileOsPermissions(workspaceId);

    if (install.code !== 0) {
      log.warn({ workspaceId, packages, stderr: install.stderr }, "apt install failed");
      return { installed: [], stdout: install.stdout, stderr: install.stderr, code: install.code };
    }

    log.info({ workspaceId, packages }, "apt install succeeded");
    return { installed: packages, stdout: install.stdout, stderr: install.stderr, code: 0 };
  });
}
