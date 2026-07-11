// Credential-proxy + secret wiring for workspace containers.
// Split out of containerManager.ts so how a container reaches the credential proxy and trusts its
// MITM CA can change independently of the Docker lifecycle (create/start/stop/remove). Everything
// here is about turning a workspace's secrets + the proxy CA into `docker run` env args and the
// one-time CA-bundle bootstrap exec — no container-lifecycle knowledge lives here.
import path from "path";
import { existsSync, readFileSync } from "fs";
import { listSecretMeta, proxyToken, selectGithubTokenSecret } from "../security/workspaceSecretStore";
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

// Path is deterministic — avoids module-isolation issues with getCACertPath() across Next.js bundles.
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

// Build the `docker run` env args that expose a workspace's secrets and route it through the
// credential proxy. Secret values NEVER leave the proxy — only opaque tokens are placed in the env;
// the proxy swaps each token for its real value on scoped HTTPS traffic.
export function buildCredentialEnv(workspaceId: string): CredentialEnv {
  // Per-workspace secret token env vars (tokens only — real values stay in the proxy).
  const secrets = listSecretMeta(workspaceId);
  const secretEnvArgs = secrets.flatMap((s) => ["-e", `${s.name}=${proxyToken(workspaceId, s.name)}`]);
  // Alias the github.com-scoped secret to GH_TOKEN so git (via the static credential helper in the
  // image) and gh both authenticate transparently, regardless of what the user named the secret.
  // Only the opaque token is exposed; the proxy swaps it for the real value on github.com traffic.
  // Skip when the secret is already named GH_TOKEN — secretEnvArgs above already emitted it, and a
  // second identical -e would just be a duplicate arg.
  const ghSecretName = selectGithubTokenSecret(secrets);
  const ghEnvArgs =
    ghSecretName && ghSecretName !== "GH_TOKEN"
      ? ["-e", `GH_TOKEN=${proxyToken(workspaceId, ghSecretName)}`]
      : [];

  const proxyReady = hasProxyCA();
  // Prod (containerized app): reach the proxy sidecar by its network alias. Local dev (app on the
  // host): the proxy runs in-process, reachable via the host gateway.
  const proxyHost = WORKSPACES_VOLUME_NAME
    ? `${CREDENTIAL_PROXY_ALIAS}:${CREDENTIAL_PROXY_PORT}`
    : `host.docker.internal:${CREDENTIAL_PROXY_PORT}`;
  // The password is the workspace's derived proxy secret, so the proxy can verify this container is
  // who it claims to be — a container that knows another workspace's id still can't forge its identity.
  const proxyUrl = proxyReady
    ? `http://${workspaceId}:${deriveProxySecret(workspaceId)}@${proxyHost}`
    : "";
  const proxyEnvArgs = proxyReady ? [
    // --add-host makes host.docker.internal resolve to the host gateway on Linux Docker
    "--add-host=host.docker.internal:host-gateway",
    "-e", `HTTP_PROXY=${proxyUrl}`,
    "-e", `HTTPS_PROXY=${proxyUrl}`,
    // Some CLI tools (notably git-remote-https/libcurl) only honor lowercase proxy env vars.
    // Set both cases so every runtime routes through the credential proxy.
    "-e", `http_proxy=${proxyUrl}`,
    "-e", `https_proxy=${proxyUrl}`,
    // NODE_EXTRA_CA_CERTS is additive (appended to Node's built-in roots), so it can point
    // at the proxy CA alone. REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / SSL_CERT_FILE / GIT_SSL_CAINFO
    // are *replacement* trust stores — pointing them at the proxy CA alone drops the public
    // roots, so TLS to tunneled (non-MITM'd) hosts like pypi.org fails with "unable to get
    // local issuer certificate". They instead point at a combined bundle (system roots +
    // proxy CA) that installProxyCA builds.
    "-e", "NODE_EXTRA_CA_CERTS=/etc/proxy-ca.crt",
    "-e", `REQUESTS_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
    "-e", `CURL_CA_BUNDLE=${COMBINED_CA_BUNDLE}`,
    "-e", `SSL_CERT_FILE=${COMBINED_CA_BUNDLE}`,
    // git's HTTPS transport (git-remote-https → libcurl) verifies against libcurl's compiled-in
    // CA path only; it ignores CURL_CA_BUNDLE (that's the curl CLI) and SSL_CERT_FILE. Without
    // this, git rejects the proxy's MITM cert on secret-scoped hosts (github.com) with an
    // "unable to get local issuer certificate" TLS error before auth substitution is reached.
    "-e", `GIT_SSL_CAINFO=${COMBINED_CA_BUNDLE}`,
    // The CA is NOT bind-mounted: the Docker daemon resolves -v sources as HOST paths, but
    // CA_CERT_PATH (/app/data/…) is the app CONTAINER's volume mount — a -v of it would make Docker
    // create an empty dir on the host and mount that, so /etc/proxy-ca.crt would be an unreadable
    // directory and no MITM cert would ever verify. Instead installProxyCA writes the PEM into the
    // container over stdin (same host-vs-container-path reason as buildVolumeArg).
  ] : [];

  return { envArgs: [...proxyEnvArgs, ...secretEnvArgs, ...ghEnvArgs], hasProxyCA: proxyReady };
}

// One-time, post-create: write the proxy CA into the container over stdin (it cannot be
// bind-mounted — see the note in buildCredentialEnv), then build the combined trust bundle the
// replacement-style vars point at (image system roots + proxy CA). Without the system roots, TLS to
// tunneled (non-MITM'd) hosts like pypi.org fails to verify; if the system bundle is missing we fall
// back to the proxy CA alone (MITM hosts still verify; tunneled ones degrade). No-op when the proxy
// CA doesn't exist. Non-fatal: failures are logged, never thrown (a broken bundle must not fail the
// container create). git's preemptive proxy Basic auth (http.proxyAuthMethod) is baked into the
// image — see Dockerfile.workspace — since it is an image-wide constant, not per-container.
export async function installProxyCA(
  docker: IDockerClient,
  containerName: string,
  workspaceId: string,
): Promise<void> {
  if (!hasProxyCA()) return;
  const caPem = readFileSync(CA_CERT_PATH, "utf-8");
  const caSetup = await docker.exec(
    containerName,
    ["sh", "-c",
      `cat > /etc/proxy-ca.crt && chmod 644 /etc/proxy-ca.crt && ` +
      `(cat /etc/ssl/certs/ca-certificates.crt /etc/proxy-ca.crt > ${COMBINED_CA_BUNDLE} 2>/dev/null || ` +
      `cp /etc/proxy-ca.crt ${COMBINED_CA_BUNDLE})`],
    { asRoot: true, stdin: caPem, trimStdout: true },
  );
  if (caSetup.code !== 0)
    log.debug({ workspaceId, stderr: caSetup.stderr }, "proxy CA install / bundle setup failed (non-fatal)");
}
