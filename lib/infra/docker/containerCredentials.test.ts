// The workspace container's env, split by what can change during the container's life:
//   - buildRunEnv  → proxy routing + CA trust, frozen at `docker run`
//   - buildExecEnv → secret tokens, supplied fresh on every `docker exec`
// The split exists because a workspace container is created once and kept indefinitely (its
// writable layer is the workspace's real content), and Docker cannot amend a container's env after
// creation — so secrets baked in at run time would be frozen at whatever the workspace had on its
// very first command.
//
// Security-critical invariants pinned here:
//   - real secret values NEVER appear (only proxyToken() placeholders)
//   - secrets NEVER appear in the run env, so they cannot be frozen into a long-lived container
//   - with no proxy CA present, NO proxy/CA env is emitted (fail safe — a token in the env with no
//     proxy to swap it is useless, but we must never wire trust to a CA that isn't there)
//   - the github-scoped secret is aliased to GH_TOKEN exactly once
// installProxyCA is a no-op without a CA and never throws on exec failure.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DockerResult, IDockerClient } from "./dockerClient";

const listSecretMeta = vi.fn();
const selectGithubTokenSecret = vi.fn();
const existsSync = vi.fn();
// Typed with the real readFileSync's parameters so the fs mock below can forward both of them.
const readFileSync = vi.fn((_path: string, _encoding?: string) => "CA-PEM-CONTENT");

vi.mock("../security/workspaceSecretStore", async (importOriginal) => ({
  listSecretMeta: (ws: string) => listSecretMeta(ws),
  // Deterministic, reversible token so tests can assert the exact env value.
  proxyToken: (ws: string, name: string) => `__pxy_${ws}_${name}__`,
  selectGithubTokenSecret: (metas: unknown) => selectGithubTokenSecret(metas),
  // The real set rather than a stand-in: a hand-written copy here could drift from the names the
  // container actually uses, and this is the boundary that refuses to inject them.
  RESERVED_SECRET_NAMES: (await importOriginal<typeof import("../security/workspaceSecretStore")>())
    .RESERVED_SECRET_NAMES,
}));
vi.mock("../proxy/proxyCA", () => ({
  deriveProxySecret: (ws: string) => `derived-${ws}`,
}));
vi.mock("fs", () => ({
  existsSync: (p: string) => existsSync(p),
  readFileSync: (p: string, enc?: string) => readFileSync(p, enc),
}));

import { buildExecEnv, buildRunEnv, hasProxyCA, installProxyCA } from "./containerCredentials";

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

describe("buildExecEnv — secret tokens", () => {
  it("emits one NAME=token entry per secret, never the real value", () => {
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY"), meta("STRIPE_KEY")]);
    expect(buildExecEnv("ws1", true)).toEqual({
      OPENAI_API_KEY: "__pxy_ws1_OPENAI_API_KEY__",
      STRIPE_KEY: "__pxy_ws1_STRIPE_KEY__",
    });
  });

  it("emits nothing when the workspace has no secrets", () => {
    expect(buildExecEnv("ws1", true)).toEqual({});
  });

  it("reflects a newly added secret immediately — this is what replaces recreating the container", () => {
    listSecretMeta.mockReturnValue([]);
    expect(buildExecEnv("ws1", true)).toEqual({});
    listSecretMeta.mockReturnValue([meta("NEW_TOKEN")]);
    expect(buildExecEnv("ws1", true)).toEqual({ NEW_TOKEN: "__pxy_ws1_NEW_TOKEN__" });
  });
});

describe("buildExecEnv — GH_TOKEN aliasing", () => {
  it("aliases the github-scoped secret to GH_TOKEN when it has a different name", () => {
    listSecretMeta.mockReturnValue([meta("MY_GH", ["github.com"])]);
    selectGithubTokenSecret.mockReturnValue("MY_GH");
    const env = buildExecEnv("ws1", true);
    expect(env.GH_TOKEN).toBe("__pxy_ws1_MY_GH__");
    expect(env.MY_GH).toBe("__pxy_ws1_MY_GH__");
  });

  it("keeps a single GH_TOKEN entry when the secret is already named GH_TOKEN", () => {
    listSecretMeta.mockReturnValue([meta("GH_TOKEN", ["github.com"])]);
    selectGithubTokenSecret.mockReturnValue("GH_TOKEN");
    expect(buildExecEnv("ws1", true)).toEqual({ GH_TOKEN: "__pxy_ws1_GH_TOKEN__" });
  });

  it("emits no GH_TOKEN when no secret is github-scoped", () => {
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY")]);
    selectGithubTokenSecret.mockReturnValue(null);
    expect(buildExecEnv("ws1", true).GH_TOKEN).toBeUndefined();
  });
});

describe("buildRunEnv — carries no secrets", () => {
  it("omits secret tokens entirely, so nothing secret is frozen into a long-lived container", () => {
    existsSync.mockReturnValue(true);
    listSecretMeta.mockReturnValue([meta("OPENAI_API_KEY"), meta("MY_GH", ["github.com"])]);
    const { envArgs } = buildRunEnv("ws1");
    expect(envValue(envArgs, "OPENAI_API_KEY")).toBeUndefined();
    expect(envValue(envArgs, "MY_GH")).toBeUndefined();
    expect(envValue(envArgs, "GH_TOKEN")).toBeUndefined();
    expect(envArgs.join(" ")).not.toContain("__pxy_");
  });

  it("is identical regardless of the workspace's secrets, so it never needs to be refreshed", () => {
    existsSync.mockReturnValue(true);
    listSecretMeta.mockReturnValue([]);
    const before = buildRunEnv("ws1").envArgs;
    listSecretMeta.mockReturnValue([meta("ADDED_LATER", ["github.com"])]);
    expect(buildRunEnv("ws1").envArgs).toEqual(before);
  });
});

describe("buildRunEnv — proxy wiring gated on the CA", () => {
  it("without a proxy CA: hasProxyCA=false and NO proxy/CA env is emitted", () => {
    existsSync.mockReturnValue(false);
    const { envArgs, hasProxyCA: ready } = buildRunEnv("ws1");
    expect(ready).toBe(false);
    expect(envValue(envArgs, "HTTP_PROXY")).toBeUndefined();
    expect(envValue(envArgs, "NODE_EXTRA_CA_CERTS")).toBeUndefined();
    expect(envArgs).not.toContain("--add-host=host.docker.internal:host-gateway");
  });

  it("with a proxy CA: hasProxyCA=true and the proxy URL carries the workspace's derived secret", () => {
    existsSync.mockReturnValue(true);
    const { envArgs, hasProxyCA: ready } = buildRunEnv("ws1");
    expect(ready).toBe(true);
    // The sidecar's network alias, and auth carrying id:derived-secret.
    expect(envValue(envArgs, "HTTP_PROXY")).toBe("http://ws1:derived-ws1@credproxy:9998");
    expect(envValue(envArgs, "http_proxy")).toBe(envValue(envArgs, "HTTP_PROXY"));
    expect(envValue(envArgs, "HTTPS_PROXY")).toBe(envValue(envArgs, "HTTP_PROXY"));
    // A workspace gets one route out, the sidecar. The host gateway is not among them.
    expect(envArgs).not.toContain("--add-host=host.docker.internal:host-gateway");
  });

  it("exempts ONLY loopback from the proxy (own-server curls bypass it; real hosts still proxied)", () => {
    existsSync.mockReturnValue(true);
    const { envArgs } = buildRunEnv("ws1");
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
    const { envArgs } = buildRunEnv("ws1");
    expect(envValue(envArgs, "NODE_EXTRA_CA_CERTS")).toBe("/etc/proxy-ca.crt");
    for (const v of ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "GIT_SSL_CAINFO"]) {
      expect(envValue(envArgs, v)).toBe("/etc/proxy-ca-bundle.crt");
    }
  });
});

// Now a per-command decision rather than one frozen at container creation, so switching internet
// off takes effect on the very next command without touching the container.
describe("buildExecEnv — internetAccess off", () => {
  it("emits no secret token env, even with secrets configured", () => {
    listSecretMeta.mockReturnValue([meta("VERCEL_TOKEN"), meta("MY_GH", ["github.com"])]);
    expect(buildExecEnv("ws1", false)).toEqual({});
  });

  it("never calls listSecretMeta — an off workspace's secrets aren't even read", () => {
    buildExecEnv("ws1", false);
    expect(listSecretMeta).not.toHaveBeenCalled();
  });

  it("passes an empty secret list into GH_TOKEN selection, so it never aliases a secret that isn't in the env", () => {
    buildExecEnv("ws1", false);
    expect(selectGithubTokenSecret).toHaveBeenCalledWith([]);
  });

  it("restores the tokens when internet comes back, with no container involvement", () => {
    listSecretMeta.mockReturnValue([meta("VERCEL_TOKEN")]);
    expect(buildExecEnv("ws1", false)).toEqual({});
    expect(buildExecEnv("ws1", true)).toEqual({ VERCEL_TOKEN: "__pxy_ws1_VERCEL_TOKEN__" });
  });
});

/**
 * An exec-level `-e` outranks the container's own environment, so a secret named after the proxy
 * address or a CA-trust path would replace that wiring with an opaque token on EVERY command — and
 * the resulting TLS failures name nothing that would lead anyone back to a secret's name.
 *
 * validateSecret refuses these names when a secret is stored, but that only covers what was written
 * after the rule existed. This is the boundary that also covers what was already in the store.
 */
describe("buildExecEnv — names the container itself uses", () => {
  it("refuses to inject a secret that would shadow the container's wiring", () => {
    listSecretMeta.mockReturnValue([meta("HTTPS_PROXY"), meta("SSL_CERT_FILE"), meta("VERCEL_TOKEN")]);
    expect(buildExecEnv("ws1", true)).toEqual({ VERCEL_TOKEN: "__pxy_ws1_VERCEL_TOKEN__" });
  });

  it("still injects everything else, so one bad name cannot disarm a workspace's other secrets", () => {
    listSecretMeta.mockReturnValue([meta("PATH"), meta("OPENAI_API_KEY"), meta("STRIPE_KEY")]);
    expect(buildExecEnv("ws1", true)).toEqual({
      OPENAI_API_KEY: "__pxy_ws1_OPENAI_API_KEY__",
      STRIPE_KEY: "__pxy_ws1_STRIPE_KEY__",
    });
  });

  // GH_TOKEN is what the github.com-scoped secret is aliased to, so reserving it would reject the
  // most obvious name a user could pick for exactly the secret this feature is built around.
  it("does not treat GH_TOKEN as reserved", () => {
    listSecretMeta.mockReturnValue([meta("GH_TOKEN", ["github.com"])]);
    selectGithubTokenSecret.mockReturnValue("GH_TOKEN");
    expect(buildExecEnv("ws1", true)).toEqual({ GH_TOKEN: "__pxy_ws1_GH_TOKEN__" });
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
