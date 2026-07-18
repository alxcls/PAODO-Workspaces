// Manages the MITM proxy's CA certificate lifecycle using node-forge.
// The CA is generated once at startup and persisted to data/.proxy-ca/.
// Per-domain certs are signed by the CA on first use and cached in memory.
// Containers trust the CA via NODE_EXTRA_CA_CERTS / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE mounts.
import forge from "node-forge";
import { createHmac, timingSafeEqual } from "crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import path from "path";
import { createLogger } from "../logger";
import { WORKSPACES_ROOT } from "../paths";
import { createKeyFile } from "../security/keyFile";

const log = createLogger("proxyCA");

let caKey: forge.pki.rsa.PrivateKey | null = null;
let caCert: forge.pki.Certificate | null = null;
let _caCertPath = "";

// Host-only key used to derive each workspace's proxy secret (HMAC of its id). Never leaves the
// host and is never handed to a container, so one workspace cannot derive another's secret.
// Held on `global` so it is shared across the custom server and Next.js route bundles, which each
// get their own module instance (same isolation pattern as the workspace/proxy singletons).
const gKey = global as typeof global & { _proxyHmacKey?: Buffer };
const PROXY_HMAC_FILE = path.join(WORKSPACES_ROOT, ".proxy-ca", "proxy-hmac.key");

// Return the HMAC key, lazily reading it from disk for module instances (e.g. an API-route bundle)
// that never ran ensureCA. Null only if the key file does not yet exist.
function getProxyHmacKey(): Buffer | null {
  if (gKey._proxyHmacKey) return gKey._proxyHmacKey;
  try {
    gKey._proxyHmacKey = readFileSync(PROXY_HMAC_FILE);
    return gKey._proxyHmacKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        { event: "proxy_hmac_key_read_failed", outcome: "credential_injection_unavailable", err },
        "failed to read proxy HMAC key",
      );
    }
    return null;
  }
}

// Shared key for all per-domain certs — generated once, persisted, reused.
// Avoids blocking RSA key generation on the event loop for every new hostname.
let domainKeyPrivatePem = "";
let domainKeyPublic: forge.pki.rsa.PublicKey | null = null;

const domainCertCache = new Map<string, { cert: string; key: string }>();

export interface EnsureCAOptions {
  /** Refuse to replace existing unreadable/partial trust material. Production uses this because
   * silently rotating it breaks trust and workspace proxy authentication. */
  strictExisting?: boolean;
}

export function ensureCA(dataDir: string, options: EnsureCAOptions = {}): void {
  const caDir = path.join(dataDir, ".proxy-ca");
  const keyFile = path.join(caDir, "ca.key");
  const certFile = path.join(caDir, "ca.crt");
  const domainKeyFile = path.join(caDir, "domain.key");
  _caCertPath = certFile;

  mkdirSync(caDir, { recursive: true });
  ensureProxyHmacKey(caDir, options.strictExisting ?? false);

  const caMaterial = [keyFile, certFile, domainKeyFile];
  const existingCount = caMaterial.filter(existsSync).length;
  if (options.strictExisting && existingCount > 0 && existingCount < caMaterial.length) {
    throw new Error("proxy CA material is incomplete — refusing to replace existing trust material");
  }

  if (existingCount === caMaterial.length) {
    try {
      caKey = forge.pki.privateKeyFromPem(readFileSync(keyFile, "utf-8"));
      caCert = forge.pki.certificateFromPem(readFileSync(certFile, "utf-8"));
      const domainPrivate = forge.pki.privateKeyFromPem(readFileSync(domainKeyFile, "utf-8"));
      domainKeyPrivatePem = readFileSync(domainKeyFile, "utf-8");
      domainKeyPublic = forge.pki.rsa.setPublicKey(
        (domainPrivate as forge.pki.rsa.PrivateKey).n,
        (domainPrivate as forge.pki.rsa.PrivateKey).e,
      );
      log.info("loaded existing proxy CA");
      return;
    } catch (err) {
      if (options.strictExisting) throw err;
      log.warn({ err }, "failed to load existing CA — regenerating");
    }
  }

  log.info("generating proxy CA and domain key pairs (2048-bit each)…");
  const caKeyPair = forge.pki.rsa.generateKeyPair(2048);
  caKey = caKeyPair.privateKey;

  const cert = forge.pki.createCertificate();
  cert.publicKey = caKeyPair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: "commonName", value: "PAODO Workspace Proxy CA" },
    { name: "organizationName", value: "PAODO" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  caCert = cert;

  const domainKeyPair = forge.pki.rsa.generateKeyPair(2048);
  domainKeyPrivatePem = forge.pki.privateKeyToPem(domainKeyPair.privateKey);
  domainKeyPublic = domainKeyPair.publicKey;

  writeFileSync(keyFile, forge.pki.privateKeyToPem(caKey), { mode: 0o600 });
  writeFileSync(certFile, forge.pki.certificateToPem(caCert));
  writeFileSync(domainKeyFile, domainKeyPrivatePem, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  chmodSync(domainKeyFile, 0o600);
  log.info({ certFile }, "proxy CA generated");
}

export function getCACertPath(): string {
  return _caCertPath;
}

// Generate (once) and load the host-only HMAC key used to derive per-workspace proxy secrets.
// Generated independently of the CA so existing deployments pick it up on the next startup.
function ensureProxyHmacKey(caDir: string, strictExisting: boolean): void {
  const keyFile = path.join(caDir, "proxy-hmac.key");
  if (existsSync(keyFile)) {
    try {
      const key = readFileSync(keyFile);
      if (strictExisting && key.length !== 32) throw new Error("proxy HMAC key is corrupt (expected 32 bytes)");
      gKey._proxyHmacKey = key;
      return;
    } catch (err) {
      if (strictExisting) throw err;
      log.warn({ err }, "failed to load proxy HMAC key — regenerating");
    }
  }
  gKey._proxyHmacKey = createKeyFile(keyFile);
  log.info("generated proxy HMAC key");
}

// The proxy secret a workspace's container authenticates with. Unguessable without the host-only
// HMAC key, so a container cannot forge another workspace's identity even if it learns the id.
export function deriveProxySecret(wsId: string): string {
  const key = getProxyHmacKey();
  if (!key) throw new Error("proxy HMAC key not initialized — call ensureCA() first");
  return createHmac("sha256", key).update(wsId).digest("hex");
}

// Constant-time check that `presented` is the correct secret for `wsId`. Returns false (rather than
// throwing) when the key is uninitialized or the input is malformed, so callers fail closed.
export function verifyProxySecret(wsId: string, presented: string | undefined): boolean {
  const key = getProxyHmacKey();
  if (!key || !presented) return false;
  const expected = Buffer.from(createHmac("sha256", key).update(wsId).digest("hex"), "latin1");
  const got = Buffer.from(presented, "latin1");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function signDomainCert(domain: string): { cert: string; key: string } {
  const cached = domainCertCache.get(domain);
  if (cached) return cached;
  if (!caKey || !caCert || !domainKeyPublic) throw new Error("proxy CA not initialized — call ensureCA() first");

  // Reuse the shared domain key — no RSA key generation here, just cert signing (~10ms).
  const cert = forge.pki.createCertificate();
  cert.publicKey = domainKeyPublic;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: domain }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "subjectAltName", altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const result = { cert: forge.pki.certificateToPem(cert), key: domainKeyPrivatePem };
  domainCertCache.set(domain, result);
  log.debug({ domain }, "signed domain cert");
  return result;
}
