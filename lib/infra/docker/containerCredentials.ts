// Credential-proxy + secret wiring for workspace containers.
// Split out of containerManager.ts so how a container reaches the credential proxy and trusts its
// MITM CA can change independently of the Docker lifecycle — no container-lifecycle knowledge lives
// here.
//
// The env is deliberately split in two, along the line of what can change during a container's
// life. A workspace container is created once and then kept indefinitely (its writable layer is the
// workspace's real content), and Docker cannot amend a container's env after creation:
//   - buildRunEnv   → constant for the workspace, so it is safe to freeze at `docker run`
//   - buildExecEnv  → secrets, which change, so they are supplied fresh on every `docker exec`
import path from "path";
import { existsSync, readFileSync } from "fs";
import {
  listSecretMeta,
  proxyToken,
  selectGithubTokenSecret,
  RESERVED_SECRET_NAMES,
} from "../security/workspaceSecretStore";
import { deriveProxySecret } from "../proxy/proxyCA";
import { WORKSPACES_ROOT } from "../paths";
import type { IDockerClient } from "./dockerClient";
import { createLogger } from "../logger";

const log = createLogger("container");

const CREDENTIAL_PROXY_PORT = process.env.CREDENTIAL_PROXY_PORT ?? "9998";
// Network alias the workspace's HTTP_PROXY targets (prod: the credproxy sidecar). Mirrored in
// containerManager, which owns the `docker network connect --alias` that makes it resolve.
const CREDENTIAL_PROXY_ALIAS = process.env.CREDENTIAL_PROXY_ALIAS ?? "credproxy";
// Set in production / Docker Compose. Its presence is how we tell "app is containerized" (reach the
// proxy sidecar by alias) from "local dev, app on host" (reach the in-process proxy via the gateway).
const WORKSPACES_VOLUME_NAME = process.env.WORKSPACES_VOLUME_NAME ?? "";

// Combined CA bundle (container system roots + proxy CA) that replacement-style trust vars
// (REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / SSL_CERT_FILE) point at. Built by installProxyCA below.
const COMBINED_CA_BUNDLE = "/etc/proxy-ca-bundle.crt";

// Recomputed from WORKSPACES_ROOT rather than read off proxyCA's module state, which each Next.js
// bundle instantiates separately — this stays correct in a bundle that never ran ensureCA.
const CA_CERT_PATH = path.join(WORKSPACES_ROOT, ".proxy-ca", "ca.crt");

// The proxy is only wired up when its CA exists (ensureCA writes the CA alongside the HMAC key
// deriveProxySecret needs). Single source of truth so env-building and CA install never disagree.
export function hasProxyCA(): boolean {
  return existsSync(CA_CERT_PATH);
}

export interface CredentialEnv {
  /** All `-e` / `--add-host` args to splice into `docker run`. */
  envArgs: string[];
  /** True when the proxy CA exists → caller must attach the proxy network and run installProxyCA. */
  hasProxyCA: boolean;
}

/**
 * The workspace's secrets, as env vars to inject on EVERY `docker exec` — never at `docker run`.
 *
 * A workspace container is created once and then lives indefinitely, because its writable layer
 * holds everything the agent has installed. Docker cannot amend a container's env after creation,
 * so anything baked in at run time is frozen for the container's whole life: a secret added later
 * would never reach the agent. Supplying secrets per command keeps them current with zero container
 * churn, and makes the internetAccess decision a live one rather than one frozen at creation.
 *
 * Secret values NEVER leave the proxy — only opaque tokens are placed in the env; the proxy swaps
 * each token for its real value on scoped HTTPS traffic. When internetAccess is false no tokens are
 * emitted at all: the workspace's network has no route out anyway (see ensureNetwork's --internal),
 * but the agent should never even see a token for an integration the user has switched off.
 */
export function buildExecEnv(workspaceId: string, internetAccess: boolean): Record<string, string> {
  const secrets = internetAccess ? listSecretMeta(workspaceId) : [];
  const env: Record<string, string> = {};
  for (const s of secrets) {
    // Never let a secret shadow the container's own wiring. validateSecret rejects these names when
    // a secret is stored, but that gate only covers what is written after the rule existed — a
    // secret already in the store would otherwise override the proxy address or a CA-trust path on
    // every single command, and the resulting TLS failures name nothing that would lead anyone
    // here. Dropping it at the injection point is what actually holds the line.
    if (RESERVED_SECRET_NAMES.has(s.name)) {
      log.warn(
        { event: "workspace_secret_name_reserved", outcome: "secret_not_injected", workspaceId, name: s.name },
        "workspace secret shadows the container's own environment — not injected",
      );
      continue;
    }
    env[s.name] = proxyToken(workspaceId, s.name);
  }
  // Alias the github.com-scoped secret to GH_TOKEN so git (via the static credential helper in the
  // image) and gh both authenticate transparently, regardless of what the user named the secret.
  // Only the opaque token is exposed; the proxy swaps it for the real value on github.com traffic.
  const ghSecretName = selectGithubTokenSecret(secrets);
  if (ghSecretName) env.GH_TOKEN = proxyToken(workspaceId, ghSecretName);
  return env;
}

/**
 * The env baked in at `docker run`: proxy routing and CA trust, nothing else.
 *
 * Everything here derives from the workspace id and whether the proxy CA exists, so it is constant
 * for the life of the workspace — which is precisely why it can safely live on a container that is
 * never recreated. `--add-host` is also a run-only flag with no `docker exec` equivalent.
 */
export function buildRunEnv(workspaceId: string): CredentialEnv {
  const proxyReady = hasProxyCA();
  // Prod (containerized app): reach the proxy sidecar by its network alias. Local dev (app on the
  // host): the proxy runs in-process, reachable via the host gateway.
  const proxyHost = WORKSPACES_VOLUME_NAME
    ? `${CREDENTIAL_PROXY_ALIAS}:${CREDENTIAL_PROXY_PORT}`
    : `host.docker.internal:${CREDENTIAL_PROXY_PORT}`;
  // The password is the workspace's derived proxy secret, so the proxy can verify this container is
  // who it claims to be — a container that knows another workspace's id still can't forge its identity.
  const proxyUrl = proxyReady ? `http://${workspaceId}:${deriveProxySecret(workspaceId)}@${proxyHost}` : "";
  const proxyEnvArgs = proxyReady
    ? [
        // --add-host makes host.docker.internal resolve to the host gateway on Linux Docker
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        `HTTP_PROXY=${proxyUrl}`,
        "-e",
        `HTTPS_PROXY=${proxyUrl}`,
        // Some CLI tools (notably git-remote-https/libcurl) only honor lowercase proxy env vars.
        // Set both cases so every runtime routes through the credential proxy.
        "-e",
        `http_proxy=${proxyUrl}`,
        "-e",
        `https_proxy=${proxyUrl}`,
        // Exempt loopback so the workspace reaches its OWN server (e.g. a dev server on
        // 0.0.0.0:8080) directly instead of routing `curl http://localhost:8080` through the
        // proxy — which returns an empty reply and makes the agent flail. This never weakens
        // secret injection: real values are only substituted for HTTPS to an exact configured
        // external domain (see credentialProxy.ts), never for loopback. Both cases, since tools
        // vary on which they honor.
        "-e",
        "no_proxy=localhost,127.0.0.1,0.0.0.0,::1",
        "-e",
        "NO_PROXY=localhost,127.0.0.1,0.0.0.0,::1",
        // NODE_EXTRA_CA_CERTS is additive (appended to Node's built-in roots), so it can point
        // at the proxy CA alone. REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / SSL_CERT_FILE / GIT_SSL_CAINFO
        // are *replacement* trust stores — pointing them at the proxy CA alone drops the public
        // roots, so TLS to tunneled (non-MITM'd) hosts like pypi.org fails with "unable to get
        // local issuer certificate". They instead point at a combined bundle (system roots +
        // proxy CA) that installProxyCA builds.
        "-e",
        "NODE_EXTRA_CA_CERTS=/etc/proxy-ca.crt",
        "-e",
        `REQUESTS_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
        "-e",
        `CURL_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
        "-e",
        `SSL_CERT_FILE=${COMBINED_CA_BUNDLE}`,
        // git's HTTPS transport (git-remote-https → libcurl) verifies against libcurl's compiled-in
        // CA path only; it ignores CURL_CA_BUNDLE (that's the curl CLI) and SSL_CERT_FILE. Without
        // this, git rejects the proxy's MITM cert on secret-scoped hosts (github.com) with an
        // "unable to get local issuer certificate" TLS error before auth substitution is reached.
        "-e",
        `GIT_SSL_CAINFO=${COMBINED_CA_BUNDLE}`,
        // The CA is NOT bind-mounted: the Docker daemon resolves -v sources as HOST paths, but
        // CA_CERT_PATH (/app/data/…) is the app CONTAINER's volume mount — a -v of it would make Docker
        // create an empty dir on the host and mount that, so /etc/proxy-ca.crt would be an unreadable
        // directory and no MITM cert would ever verify. Instead installProxyCA writes the PEM into the
        // container over stdin (same host-vs-container-path reason as buildVolumeArg).
      ]
    : [];

  return { envArgs: proxyEnvArgs, hasProxyCA: proxyReady };
}

// One-time, post-create: write the proxy CA into the container over stdin (it cannot be
// bind-mounted — see the note in buildCredentialEnv), then build the combined trust bundle the
// replacement-style vars point at (image system roots + proxy CA). Without the system roots, TLS to
// tunneled (non-MITM'd) hosts like pypi.org fails to verify; if the system bundle is missing we fall
// back to the proxy CA alone (MITM hosts still verify; tunneled ones degrade). No-op when the proxy
// CA doesn't exist. Non-fatal: failures are logged, never thrown (a broken bundle must not fail the
// container create). git's preemptive proxy Basic auth (http.proxyAuthMethod) is baked into the
// image — see Dockerfile.workspace — since it is an image-wide constant, not per-container.
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
