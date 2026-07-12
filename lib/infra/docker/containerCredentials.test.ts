// buildCredentialEnv assembles the `docker run` env that exposes a workspace's secrets as opaque
// tokens and routes it through the credential proxy. The security-critical invariants pinned here:
//   - real secret values NEVER appear in the args (only proxyToken() placeholders)
//   - with no proxy CA present, NO proxy/CA env is emitted (fail safe — a token in the env with no
//     proxy to swap it is useless, but we must never wire trust to a CA that isn't there)
//   - the github-scoped secret is aliased to GH_TOKEN exactly once
// installProxyCA is a no-op without a CA and never throws on exec failure.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DockerResult, IDockerClient } from "./dockerClient";

const listSecretMeta = vi.fn();
const selectGithubTokenSecret = vi.fn();
const existsSync = vi.fn();
const readFileSync = vi.fn(() => "CA-PEM-CONTENT");

vi.mock("../security/workspaceSecretStore", () => ({
  listSecretMeta: (ws: string) => listSecretMeta(ws),
  // Deterministic, reversible token so tests can assert the exact env value.
  proxyToken: (ws: string, name: string) => `__pxy_${ws}_${name}__`,
  selectGithubTokenSecret: (metas: unknown) => selectGithubTokenSecret(metas),
}));
vi.mock("../proxy/proxyCA", () => ({
  deriveProxySecret: (ws: string) => `derived-${ws}`,
}));
vi.mock("fs", () => ({
  existsSync: (p: string) => existsSync(p),
  readFileSync: (p: string, enc?: string) => readFileSync(p, enc),
}));

import { buildCredentialEnv, hasProxyCA, installProxyCA } from "./containerCredentials";

const meta = (name: string, domains: string[] = []) => ({ name, createdAt: "2026-01-01", domains });

beforeEach(() => {
  vi.clearAllMocks();
  listSecretMeta.mockReturnValue([]);
  selectGithubTokenSecret.mockReturnValue(null);
  existsSync.mockReturnValue(false); // default: no proxy CA
  readFileSync.mockReturnValue("CA-PEM-CONTENT");
});

// Pull the value out of a `-e NAME=value` pair within a flat args array.
function envValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e" && args[i + 1].startsWith(`${name}=`)) return args[i + 1].slice(name.length + 1);
  }
  return undefined;
}

describe("buildCredentialEnv — secret tokens", () => {
  it("emits one -e NAME=token per secret, never the real value", () => {
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY"), meta("STRIPE_KEY")]);
    const { envArgs } = buildCredentialEnv("ws1");
    expect(envValue(envArgs, "OPENAI_API_KEY")).toBe("__pxy_ws1_OPENAI_API_KEY__");
    expect(envValue(envArgs, "STRIPE_KEY")).toBe("__pxy_ws1_STRIPE_KEY__");
  });

  it("emits no secret env when the workspace has no secrets", () => {
    const { envArgs } = buildCredentialEnv("ws1");
    expect(envArgs.filter((a) => a === "-e")).toHaveLength(0);
  });
});

describe("buildCredentialEnv — GH_TOKEN aliasing", () => {
  it("aliases the github-scoped secret to GH_TOKEN when it has a different name", () => {
    listSecretMeta.mockReturnValue([meta("MY_GH", ["github.com"])]);
    selectGithubTokenSecret.mockReturnValue("MY_GH");
    const { envArgs } = buildCredentialEnv("ws1");
    expect(envValue(envArgs, "GH_TOKEN")).toBe("__pxy_ws1_MY_GH__");
    expect(envValue(envArgs, "MY_GH")).toBe("__pxy_ws1_MY_GH__");
  });

  it("does NOT emit a duplicate GH_TOKEN when the secret is already named GH_TOKEN", () => {
    listSecretMeta.mockReturnValue([meta("GH_TOKEN", ["github.com"])]);
    selectGithubTokenSecret.mockReturnValue("GH_TOKEN");
    const { envArgs } = buildCredentialEnv("ws1");
    const ghCount = envArgs.filter((a) => a.startsWith("GH_TOKEN=")).length;
    expect(ghCount).toBe(1);
  });

  it("emits no GH_TOKEN when no secret is github-scoped", () => {
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY")]);
    selectGithubTokenSecret.mockReturnValue(null);
    const { envArgs } = buildCredentialEnv("ws1");
    expect(envValue(envArgs, "GH_TOKEN")).toBeUndefined();
  });
});

describe("buildCredentialEnv — proxy wiring gated on the CA", () => {
  it("without a proxy CA: hasProxyCA=false and NO proxy/CA env is emitted", () => {
    existsSync.mockReturnValue(false);
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY")]);
    const { envArgs, hasProxyCA: ready } = buildCredentialEnv("ws1");
    expect(ready).toBe(false);
    expect(envValue(envArgs, "HTTP_PROXY")).toBeUndefined();
    expect(envValue(envArgs, "NODE_EXTRA_CA_CERTS")).toBeUndefined();
    expect(envArgs).not.toContain("--add-host=host.docker.internal:host-gateway");
    // secret token still exposed — the proxy simply isn't wired yet
    expect(envValue(envArgs, "OPENAI_API_KEY")).toBe("__pxy_ws1_OPENAI_API_KEY__");
  });

  it("with a proxy CA: hasProxyCA=true and the proxy URL carries the workspace's derived secret", () => {
    existsSync.mockReturnValue(true);
    const { envArgs, hasProxyCA: ready } = buildCredentialEnv("ws1");
    expect(ready).toBe(true);
    // Local-dev host (no WORKSPACES_VOLUME_NAME in the test env) — the auth carries id:derived-secret.
    expect(envValue(envArgs, "HTTP_PROXY")).toBe("http://ws1:derived-ws1@host.docker.internal:9998");
    expect(envValue(envArgs, "http_proxy")).toBe(envValue(envArgs, "HTTP_PROXY"));
    expect(envValue(envArgs, "HTTPS_PROXY")).toBe(envValue(envArgs, "HTTP_PROXY"));
  });

  it("exempts ONLY loopback from the proxy (own-server curls bypass it; real hosts still proxied)", () => {
    existsSync.mockReturnValue(true);
    const { envArgs } = buildCredentialEnv("ws1");
    const loopbacks = "localhost,127.0.0.1,0.0.0.0,::1";
    // Both cases set, matching the http_proxy/HTTP_PROXY pattern (tools vary on which they honor).
    expect(envValue(envArgs, "no_proxy")).toBe(loopbacks);
    expect(envValue(envArgs, "NO_PROXY")).toBe(loopbacks);
    // Security invariant: the exemption is loopback-only — no external host is exempted, so secret
    // injection to configured domains is untouched (real values still flow through the proxy).
    for (const host of ["github.com", "api.openai.com", "example.com"]) {
      expect(envValue(envArgs, "no_proxy")).not.toContain(host);
    }
  });

  it("with a proxy CA: points the replacement-style trust vars at the combined bundle", () => {
    existsSync.mockReturnValue(true);
    const { envArgs } = buildCredentialEnv("ws1");
    expect(envValue(envArgs, "NODE_EXTRA_CA_CERTS")).toBe("/etc/proxy-ca.crt");
    for (const v of ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "GIT_SSL_CAINFO"]) {
      expect(envValue(envArgs, v)).toBe("/etc/proxy-ca-bundle.crt");
    }
  });
});

describe("hasProxyCA", () => {
  it("reflects existence of the CA cert on disk", () => {
    existsSync.mockReturnValue(true);
    expect(hasProxyCA()).toBe(true);
    existsSync.mockReturnValue(false);
    expect(hasProxyCA()).toBe(false);
  });
});

describe("installProxyCA", () => {
  const ok: DockerResult = { stdout: "", stderr: "", code: 0 };
  const fakeDocker = (result: DockerResult) => {
    const exec = vi.fn<IDockerClient["exec"]>().mockResolvedValue(result);
    return { exec, cmd: vi.fn() } as unknown as IDockerClient & { exec: typeof exec };
  };

  it("is a no-op (no exec) when there is no proxy CA", async () => {
    existsSync.mockReturnValue(false);
    const docker = fakeDocker(ok);
    await installProxyCA(docker, "ws_1", "ws1");
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it("writes the CA over stdin as root when the CA exists", async () => {
    existsSync.mockReturnValue(true);
    const docker = fakeDocker(ok);
    await installProxyCA(docker, "ws_1", "ws1");
    expect(docker.exec).toHaveBeenCalledTimes(1);
    const [container, argv, opts] = docker.exec.mock.calls[0];
    expect(container).toBe("ws_1");
    expect(argv[0]).toBe("sh");
    expect(opts).toMatchObject({ asRoot: true, stdin: "CA-PEM-CONTENT" });
  });

  it("does not throw when the bootstrap exec fails (non-fatal)", async () => {
    existsSync.mockReturnValue(true);
    const docker = fakeDocker({ stdout: "", stderr: "boom", code: 1 });
    await expect(installProxyCA(docker, "ws_1", "ws1")).resolves.toBeUndefined();
  });
});
