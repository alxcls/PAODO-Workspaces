// The workspace container's env and CA trust. buildRunEnv is frozen at `docker run`; buildExecEnv is
// supplied on every `docker exec`, because secrets change and a container's env cannot be amended.
import path from "path";
import { existsSync, readFileSync } from "fs";
import {
  listSecretMeta,
  proxyToken,
  selectGithubTokenSecret,
  RESERVED_SECRET_NAMES,
} from "../security/workspaceSecretStore";
import { WORKSPACES_ROOT } from "../paths";
import { envArgs, type IDockerClient } from "./dockerClient";
import { RELAY_PROXY_URL } from "./proxyRelay";
import { createLogger } from "../logger";

const log = createLogger("container");

// System roots + proxy CA, built by installProxyCA, for the trust vars that replace the default store.
const COMBINED_CA_BUNDLE = "/etc/proxy-ca-bundle.crt";

// Recomputed from WORKSPACES_ROOT rather than read off proxyCA's module state, which each Next.js
// bundle instantiates separately — this stays correct in a bundle that never ran ensureCA.
const CA_CERT_PATH = path.join(WORKSPACES_ROOT, ".proxy-ca", "ca.crt");

const LOOPBACK = "localhost,127.0.0.1,0.0.0.0,::1";

// Both cases, since tools differ on which they honor (git's libcurl reads only lowercase).
const RELAY_ROUTING = {
  HTTP_PROXY: RELAY_PROXY_URL,
  HTTPS_PROXY: RELAY_PROXY_URL,
  http_proxy: RELAY_PROXY_URL,
  https_proxy: RELAY_PROXY_URL,
};

// The proxy is only wired up when its CA exists (ensureCA writes the CA alongside the HMAC key
// deriveProxySecret needs). Single source of truth so env-building and CA install never disagree.
export function hasProxyCA(): boolean {
  return existsSync(CA_CERT_PATH);
}

export interface CredentialEnv {
  /** All `-e` args to splice into `docker run`. */
  envArgs: string[];
  /** True when the proxy CA exists → caller must attach the proxy network and run installProxyCA. */
  hasProxyCA: boolean;
}

/**
 * The env for ONE `docker exec`: the workspace's secrets as opaque tokens (the proxy swaps in real
 * values on scoped HTTPS), none at all while internet access is off, and routing through the egress
 * relay once it is up. Recomputed per command, so a secret added later reaches the very next one.
 */
export function buildExecEnv(workspaceId: string, internetAccess: boolean, relayReady = false): Record<string, string> {
  const secrets = internetAccess ? listSecretMeta(workspaceId) : [];
  // Node's fetch/http(s) ignore HTTP(S)_PROXY without this. Set per exec so older containers get it too.
  const env: Record<string, string> = { NODE_USE_ENV_PROXY: "1" };
  for (const s of secrets) {
    // Never let a secret shadow the container's own wiring, including one stored before the rule existed.
    if (RESERVED_SECRET_NAMES.has(s.name)) {
      log.warn(
        { event: "workspace_secret_name_reserved", outcome: "secret_not_injected", workspaceId, name: s.name },
        "workspace secret shadows the container's own environment — not injected",
      );
      continue;
    }
    env[s.name] = proxyToken(workspaceId, s.name);
  }
  // git's credential helper and gh read GH_TOKEN, whatever the github.com-scoped secret is named.
  const ghSecretName = selectGithubTokenSecret(secrets);
  if (ghSecretName) env.GH_TOKEN = proxyToken(workspaceId, ghSecretName);
  // Containers created before the relay carry a credentialed proxy URL in their run env; this replaces it.
  if (relayReady) Object.assign(env, RELAY_ROUTING);
  return env;
}

/**
 * The env baked in at `docker run`: proxy routing and CA trust, constant for the container's life.
 * The proxy credentials live only in the egress relay's root-written config, never in this env.
 */
export function buildRunEnv(): CredentialEnv {
  if (!hasProxyCA()) return { envArgs: [], hasProxyCA: false };
  const env: Record<string, string> = {
    ...RELAY_ROUTING,
    // Loopback stays direct, so the workspace reaches its own servers (a dev server on :8080).
    no_proxy: LOOPBACK,
    NO_PROXY: LOOPBACK,
    // Additive to Node's built-in roots, so the proxy CA alone is enough here.
    NODE_EXTRA_CA_CERTS: "/etc/proxy-ca.crt",
    // These REPLACE the default store, so they need public roots too or tunneled hosts fail to verify.
    REQUESTS_CA_BUNDLE: COMBINED_CA_BUNDLE,
    CURL_CA_BUNDLE: COMBINED_CA_BUNDLE,
    SSL_CERT_FILE: COMBINED_CA_BUNDLE,
    // git's libcurl ignores CURL_CA_BUNDLE and SSL_CERT_FILE.
    GIT_SSL_CAINFO: COMBINED_CA_BUNDLE,
  };
  return { envArgs: envArgs(env), hasProxyCA: true };
}

// Writes the proxy CA in over stdin (a -v mount would resolve on the host, not this app container's
// volume), then builds the combined bundle. No-op without a CA; failures are logged, never thrown.
export async function installProxyCA(docker: IDockerClient, containerName: string, workspaceId: string): Promise<void> {
  if (!hasProxyCA()) return;
  const caPem = readFileSync(CA_CERT_PATH, "utf-8");
  const caSetup = await docker.exec(
    containerName,
    [
      "sh",
      "-c",
      `cat > /etc/proxy-ca.crt && chmod 644 /etc/proxy-ca.crt && ` +
        `(cat /etc/ssl/certs/ca-certificates.crt /etc/proxy-ca.crt > ${COMBINED_CA_BUNDLE} 2>/dev/null || ` +
        `cp /etc/proxy-ca.crt ${COMBINED_CA_BUNDLE})`,
    ],
    { asRoot: true, stdin: caPem, trimStdout: true },
  );
  if (caSetup.code !== 0) {
    log.warn(
      {
        event: "workspace_proxy_ca_install_failed",
        outcome: "workspace_proxy_trust_degraded",
        workspaceId,
        stderr: caSetup.stderr,
      },
      "proxy CA install or bundle setup failed",
    );
  }
}
