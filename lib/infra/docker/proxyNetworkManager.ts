// Keeps the credential-proxy sidecar attached to each per-workspace isolated network.
//
// In production the proxy runs in its own sidecar container (compose service `credproxy`), NOT in the
// app. The app attaches that sidecar — never itself — to each per-workspace network, so a workspace
// can reach only the proxy and never the app's control plane. A workspace's HTTP_PROXY targets
// CREDENTIAL_PROXY_ALIAS (a network alias); CREDENTIAL_PROXY_CONTAINER is the container name the app
// runs `docker network connect` against.
//
// This is prod-only orchestration: when WORKSPACES_VOLUME_NAME is unset (local dev), there is no
// sidecar (the proxy is in-process) and every method here is a no-op. The env-var / CA-trust side of
// proxy wiring lives in containerCredentials.ts.
import { createLogger } from "../logger";
import type { IDockerClient } from "./dockerClient";
import { networkName } from "./naming";

const log = createLogger("container");

const CREDENTIAL_PROXY_ALIAS = process.env.CREDENTIAL_PROXY_ALIAS ?? "credproxy";
const CREDENTIAL_PROXY_CONTAINER = process.env.CREDENTIAL_PROXY_CONTAINER ?? "paodo_ws_credproxy";
// Set in production (Docker Compose); its presence is the "we're containerized, a sidecar exists"
// signal that gates all of the below.
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

export class ProxyNetworkManager {
  constructor(private docker: IDockerClient) {}

  // True only in production, where a credproxy sidecar exists to attach.
  get enabled(): boolean {
    return !!WORKSPACES_VOLUME_NAME;
  }

  // Attach the sidecar (never the app itself) to a workspace's isolated network so the workspace
  // resolves `${CREDENTIAL_PROXY_ALIAS}` to the proxy and can reach nothing else the app hosts.
  // Idempotent: a repeat connect ("already exists") is not an error. No-op in local dev.
  async attach(workspaceId: string): Promise<void> {
    if (!this.enabled) return;
    const r = await this.docker.cmd(
      "network", "connect", "--alias", CREDENTIAL_PROXY_ALIAS,
      networkName(workspaceId), CREDENTIAL_PROXY_CONTAINER,
    );
    if (r.code !== 0 && !/already (exists|connected)/i.test(r.stderr)) {
      log.warn({ workspaceId, stderr: r.stderr }, "failed to attach credential proxy to workspace network");
    }
  }

  // True when the sidecar is currently an endpoint on the workspace's network, so the alias resolves
  // inside the container. Host-side check (docker network inspect) — deliberately avoids exec'ing into
  // the container, whose image may lack getent/nslookup.
  private async isAttached(workspaceId: string): Promise<boolean> {
    const r = await this.docker.cmd(
      "network", "inspect", networkName(workspaceId),
      "--format", "{{range .Containers}}{{.Name}} {{end}}",
    );
    if (r.code !== 0) return false;
    return r.stdout.split(/\s+/).includes(CREDENTIAL_PROXY_CONTAINER);
  }

  // Guarantee the workspace can reach the credential proxy before the agent runs against it. If the
  // sidecar isn't on the network (typically because a redeploy recreated it and dropped the
  // attachment), reattach and re-check; if it still isn't reachable, throw with an actionable message
  // rather than letting egress silently black-hole. No-op in local dev.
  async verify(workspaceId: string): Promise<void> {
    if (!this.enabled) return;
    if (await this.isAttached(workspaceId)) return;
    log.warn({ workspaceId }, "credential proxy not attached to workspace network — reattaching");
    await this.attach(workspaceId);
    if (await this.isAttached(workspaceId)) return;
    throw new Error(
      `workspace egress proxy (${CREDENTIAL_PROXY_ALIAS}) is not attached to ${networkName(workspaceId)} — ` +
        `check the ${CREDENTIAL_PROXY_CONTAINER} sidecar is running`,
    );
  }

  // Detach the sidecar before removing a workspace network — `network rm` fails while an endpoint is
  // still attached. Non-fatal (the sidecar may not be attached). No-op in local dev.
  async detach(workspaceId: string): Promise<void> {
    if (!this.enabled) return;
    const r = await this.docker.cmd(
      "network", "disconnect", "-f", networkName(workspaceId), CREDENTIAL_PROXY_CONTAINER,
    );
    if (r.code !== 0) log.debug({ workspaceId, stderr: r.stderr }, "detach credential proxy (may not be attached)");
  }

  // On boot, reconnect the sidecar to every running workspace network. A redeploy recreates the
  // sidecar (and the app), dropping its attachments while workspace containers keep running; without
  // this their egress would black-hole until they are recreated. No-op in local dev.
  async reattachAll(): Promise<void> {
    if (!this.enabled) return;
    const r = await this.docker.cmd("ps", "--filter", "name=^ws_", "--format", "{{.Names}}");
    if (r.code !== 0) { log.warn({ stderr: r.stderr }, "reattachProxyNetworks: docker ps failed"); return; }
    for (const name of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      await this.attach(name.replace(/^ws_/, ""));
    }
  }
}
