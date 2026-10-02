// In-container egress relay: tinyproxy on 127.0.0.1:3128 adds the workspace's proxy identity and
// forwards to the credential proxy, so any proxy-aware tool works without credentials.
import type { IDockerClient } from "./dockerClient";
import { deriveProxySecret } from "../proxy/proxyCA";
import { PROXY_RELAY_INSTALL_TIMEOUT_MS } from "../limits";
import { createLogger } from "../logger";

const log = createLogger("container");

const RELAY_PORT = 3128;
export const RELAY_PROXY_URL = `http://127.0.0.1:${RELAY_PORT}`;

// The relay's upstream: the credproxy sidecar, reached by its alias on the workspace network.
const CREDENTIAL_PROXY_PORT = process.env.CREDENTIAL_PROXY_PORT ?? "9998";
const CREDENTIAL_PROXY_ALIAS = process.env.CREDENTIAL_PROXY_ALIAS ?? "credproxy";

// Runs as nobody: the agent (uid 1000) can neither read its config nor signal it. Root can't
// signal it either (no CAP_KILL), so restarts switch to nobody first.
const RELAY_UID = 65534;
const RELAY_DIR = "/etc/paodo-relay";
const RELAY_CONF = `${RELAY_DIR}/tinyproxy.conf`;
const AS_RELAY = `setpriv --reuid=${RELAY_UID} --regid=${RELAY_UID} --clear-groups`;
// 127.0.0.1:3128 as /proc/net/tcp spells it, to confirm the relay's own uid holds the port.
const LISTEN_ADDRESS = `0100007F:${RELAY_PORT.toString(16).toUpperCase().padStart(4, "0")}`;
const NOT_INSTALLED = 3;

// Run as root with the config on stdin. flock makes a second start a no-op, a changed config restarts
// tinyproxy, and the script exits 0 only once the relay is listening.
const START_SCRIPT = [
  `command -v tinyproxy > /dev/null || exit ${NOT_INSTALLED}`,
  `mkdir -p ${RELAY_DIR} && chown ${RELAY_UID}:${RELAY_UID} ${RELAY_DIR} && chmod 700 ${RELAY_DIR}`,
  "umask 077",
  `cat > ${RELAY_CONF}.new && chown ${RELAY_UID}:${RELAY_UID} ${RELAY_CONF}.new`,
  `if cmp -s ${RELAY_CONF}.new ${RELAY_CONF}; then rm -f ${RELAY_CONF}.new; ` +
    `else mv ${RELAY_CONF}.new ${RELAY_CONF}; ${AS_RELAY} pkill -x tinyproxy; fi`,
  `${AS_RELAY} setsid flock -n ${RELAY_DIR}/lock sh -c ` +
    `"while :; do tinyproxy -d -c ${RELAY_CONF} > ${RELAY_DIR}/relay.log 2>&1; sleep 1; done" ` +
    "< /dev/null > /dev/null 2>&1 &",
  "for i in $(seq 30); do",
  `  awk '$2 == "${LISTEN_ADDRESS}" && $4 == "0A" && $8 == ${RELAY_UID} { up = 1 } END { exit !up }' /proc/net/tcp && exit 0`,
  "  sleep 0.1",
  "done",
  `cat ${RELAY_DIR}/relay.log >&2`,
  "exit 1",
].join("\n");

// The image ships tinyproxy-bin; containers created before it get the package on their next wake.
const INSTALL_SCRIPT =
  "apt-get update && apt-get install -y --no-install-recommends tinyproxy-bin; " +
  "rc=$?; apt-get clean; rm -rf /var/lib/apt/lists/*; exit $rc";

function credentialProxyUpstream(workspaceId: string): string {
  return `${workspaceId}:${deriveProxySecret(workspaceId)}@${CREDENTIAL_PROXY_ALIAS}:${CREDENTIAL_PROXY_PORT}`;
}

export function buildRelayConfig(workspaceId: string): string {
  return [
    `Port ${RELAY_PORT}`,
    "Listen 127.0.0.1",
    "Allow 127.0.0.1",
    // tinyproxy's 600s idle default would cut long streams and slow downloads.
    "Timeout 3600",
    "MaxClients 100",
    "DisableViaHeader Yes",
    "LogLevel Critical",
    `Upstream http ${credentialProxyUpstream(workspaceId)}`,
    "",
  ].join("\n");
}

function startRelay(docker: IDockerClient, containerName: string, workspaceId: string) {
  return docker.exec(containerName, ["sh", "-c", START_SCRIPT], {
    asRoot: true,
    stdin: buildRelayConfig(workspaceId),
    trimStdout: true,
  });
}

// apt gets the credentialed proxy directly, so the install never depends on the relay it installs.
async function installRelay(docker: IDockerClient, containerName: string, workspaceId: string): Promise<boolean> {
  const proxy = `http://${credentialProxyUpstream(workspaceId)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PROXY_RELAY_INSTALL_TIMEOUT_MS);
  });
  try {
    const install = docker.exec(containerName, ["sh", "-c", INSTALL_SCRIPT], {
      asRoot: true,
      trimStdout: true,
      env: { http_proxy: proxy, https_proxy: proxy },
    });
    const r = await Promise.race([install, deadline]);
    if (r === "timeout" || r.code !== 0) {
      log.warn(
        {
          event: "workspace_proxy_relay_install_failed",
          outcome: "workspace_egress_not_relayed",
          workspaceId,
          ...(r === "timeout" ? { timeoutMs: PROXY_RELAY_INSTALL_TIMEOUT_MS } : { stderr: r.stderr }),
        },
        "egress relay install failed — retried on the next wake",
      );
      return false;
    }
    log.info(
      { event: "workspace_proxy_relay_installed", outcome: "workspace_egress_relay_available", workspaceId },
      "egress relay installed into an existing container",
    );
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the workspace's egress relay, installing it first when `canInstall` (the install needs
 * internet). Resolves true once the relay is listening; never rejects.
 */
export async function ensureProxyRelay(
  docker: IDockerClient,
  containerName: string,
  workspaceId: string,
  canInstall: boolean,
): Promise<boolean> {
  try {
    let r = await startRelay(docker, containerName, workspaceId);
    if (r.code === NOT_INSTALLED) {
      if (!canInstall || !(await installRelay(docker, containerName, workspaceId))) return false;
      r = await startRelay(docker, containerName, workspaceId);
    }
    if (r.code === 0) return true;
    log.error(
      {
        event: "workspace_proxy_relay_failed",
        outcome: "workspace_egress_not_relayed",
        workspaceId,
        code: r.code,
        stderr: r.stderr,
      },
      "egress relay did not start",
    );
  } catch (err) {
    log.error(
      { event: "workspace_proxy_relay_failed", outcome: "workspace_egress_not_relayed", workspaceId, err },
      "egress relay did not start",
    );
  }
  return false;
}
