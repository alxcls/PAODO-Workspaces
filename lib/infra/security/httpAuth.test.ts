// These guards front every request to the app. The dangerous failures are the inverse of each
// function's job: checkAuth returning "ok" for a bad/absent credential, and isCsrf returning false
// for a genuine cross-site mutation. Tests lock down both directions.
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  AuthFailureTracker,
  checkAuth,
  checkWsAuth,
  isCsrf,
  authRequestFromIncoming,
  getClientIp,
  trustedRequestHosts,
  trustedRequestOrigins,
  type AuthRequest,
  validateRequestHost,
  validateRequestOrigin,
} from "./httpAuth";
import { basicAuthenticator, type UiAuthenticator } from "./uiAuth";

// checkAuth is mode-agnostic, so these exercise it through the Basic authenticator and assert the
// seam separately where a mode's own behaviour matters. Mode internals live in uiAuth.test.ts.
const UI = basicAuthenticator({ user: "admin", pass: "hunter2" });

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function req(partial: Partial<AuthRequest> = {}): AuthRequest {
  return {
    method: "GET",
    pathname: "/",
    authorization: "",
    cookie: "",
    assertion: "",
    hostname: "",
    isUpgrade: false,
    ...partial,
  };
}

// A stand-in for any assertion-header mode, so checkAuth's contract is tested without a real JWKS.
function assertionAuthenticator(valid: string): UiAuthenticator {
  return {
    mode: "iap",
    assertionHeader: "x-assertion",
    challenge: null,
    prime: () => Promise.resolve(),
    verify: ({ assertion }) => (!assertion ? "absent" : assertion === valid ? "ok" : "invalid"),
  };
}

describe("AuthFailureTracker", () => {
  it("blocks after max failures within the window and clears on success", () => {
    const t = new AuthFailureTracker(3, 60_000);
    expect(t.isBlocked("1.1.1.1")).toBe(false);
    t.recordFailure("1.1.1.1");
    t.recordFailure("1.1.1.1");
    expect(t.isBlocked("1.1.1.1")).toBe(false); // 2 < 3
    t.recordFailure("1.1.1.1");
    expect(t.isBlocked("1.1.1.1")).toBe(true); // 3 >= 3
    t.clear("1.1.1.1");
    expect(t.isBlocked("1.1.1.1")).toBe(false);
  });

  it("resets the count once the window elapses", () => {
    vi.useFakeTimers();
    try {
      const t = new AuthFailureTracker(1, 1_000);
      t.recordFailure("2.2.2.2");
      expect(t.isBlocked("2.2.2.2")).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(t.isBlocked("2.2.2.2")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks IPs independently", () => {
    const t = new AuthFailureTracker(1, 60_000);
    t.recordFailure("a");
    expect(t.isBlocked("a")).toBe(true);
    expect(t.isBlocked("b")).toBe(false);
  });
});

describe("trusted request hosts", () => {
  const trusted = trustedRequestHosts({
    PAODO_TRUSTED_HOSTS: "ui.example.com, admin.example.com:8443",
    WORKSPACE_API_DOMAIN: "api.example.com",
  });

  it("includes local, Docker-internal, UI and public API hostnames", () => {
    expect([...trusted]).toEqual(
      expect.arrayContaining([
        "localhost",
        "127.0.0.1",
        "::1",
        "app",
        "ui.example.com",
        "admin.example.com",
        "api.example.com",
      ]),
    );
  });

  it("accepts a trusted Host with any port and an agreeing forwarded host", () => {
    expect(validateRequestHost({ host: "UI.Example.com:3000" }, trusted)).toEqual({
      ok: true,
      hostname: "ui.example.com",
    });
    expect(
      validateRequestHost({ host: "api.example.com:3000", "x-forwarded-host": "api.example.com:443" }, trusted),
    ).toEqual({ ok: true, hostname: "api.example.com" });
  });

  it("rejects missing, malformed and untrusted Host values", () => {
    expect(validateRequestHost({}, trusted)).toEqual({ ok: false, reason: "host_missing" });
    expect(validateRequestHost({ host: "ui.example.com,evil.example" }, trusted)).toEqual({
      ok: false,
      reason: "host_malformed",
    });
    expect(validateRequestHost({ host: "evil.example" }, trusted)).toEqual({
      ok: false,
      reason: "host_untrusted",
    });
  });

  it("rejects duplicate, malformed, untrusted or disagreeing X-Forwarded-Host values", () => {
    expect(
      validateRequestHost({ host: "ui.example.com", "x-forwarded-host": ["ui.example.com", "evil.example"] }, trusted),
    ).toEqual({ ok: false, reason: "forwarded_host_malformed" });
    expect(validateRequestHost({ host: "ui.example.com", "x-forwarded-host": "evil.example" }, trusted)).toEqual({
      ok: false,
      reason: "host_mismatch",
    });
    expect(validateRequestHost({ host: "ui.example.com", "x-forwarded-host": "ui.example.com/path" }, trusted)).toEqual(
      { ok: false, reason: "forwarded_host_malformed" },
    );
  });

  it("fails startup configuration closed when an allowlist entry is malformed", () => {
    expect(() => trustedRequestHosts({ PAODO_TRUSTED_HOSTS: "good.example,bad.example/path" })).toThrow(
      "invalid trusted hostname",
    );
  });
});

describe("trustedRequestOrigins", () => {
  const env = { PAODO_TRUSTED_HOSTS: "ui.example.com", WORKSPACE_API_DOMAIN: "api.example.com" };

  it("trusts only the declared public UI hostnames in production", () => {
    const origins = trustedRequestOrigins(env, false);
    expect([...origins]).toEqual(["ui.example.com"]);
  });

  it("adds loopback in dev, where it is the UI's own origin", () => {
    const origins = trustedRequestOrigins(env, true);
    expect(origins.has("localhost")).toBe(true);
    expect(origins.has("127.0.0.1")).toBe(true);
    expect(origins.has("::1")).toBe(true);
  });

  it("trusts loopback on a production build that declares no public hostname", () => {
    expect([...trustedRequestOrigins({}, false)]).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("drops loopback in the same edit that declares a public hostname", () => {
    expect(trustedRequestOrigins({ PAODO_TRUSTED_HOSTS: "ui.example.com" }, false).has("localhost")).toBe(false);
  });

  // Each is required for Host validation and each would be a cross-site handshake if trusted here.
  it("never inherits the host-only entries that make trustedRequestHosts unsafe as an origin list", () => {
    const hosts = trustedRequestHosts(env);
    const origins = trustedRequestOrigins(env, false);
    for (const hostOnly of ["localhost", "127.0.0.1", "::1", "app", "api.example.com"]) {
      expect(hosts.has(hostOnly)).toBe(true);
      expect(origins.has(hostOnly)).toBe(false);
    }
  });

  it("fails startup configuration closed when an entry is malformed", () => {
    expect(() => trustedRequestOrigins({ PAODO_TRUSTED_HOSTS: "bad.example/path" }, false)).toThrow(
      "invalid trusted origin hostname",
    );
  });
});

describe("validateRequestOrigin (cross-site WebSocket hijacking)", () => {
  const env = { PAODO_TRUSTED_HOSTS: "ui.example.com" };
  const trusted = trustedRequestOrigins(env, false);

  it("accepts a handshake opened by a page on a trusted host, whatever its port or case", () => {
    expect(validateRequestOrigin("https://ui.example.com", trusted)).toBe(true);
    expect(validateRequestOrigin("https://UI.Example.com:8443", trusted)).toBe(true);
  });

  // Otherwise any page on the user's own machine opens a socket on cached Basic credentials.
  it("accepts the dev server's own origin only in dev", () => {
    const inDev = trustedRequestOrigins(env, true);
    expect(validateRequestOrigin("http://localhost:3000", inDev)).toBe(true);
    expect(validateRequestOrigin("http://[::1]:3000", inDev)).toBe(true);
    expect(validateRequestOrigin("http://localhost:3000", trusted)).toBe(false);
    expect(validateRequestOrigin("http://localhost:8080", trusted)).toBe(false);
    expect(validateRequestOrigin("http://127.0.0.1:8080", trusted)).toBe(false);
    expect(validateRequestOrigin("http://[::1]:3000", trusted)).toBe(false);
  });

  it("rejects a handshake opened by any other page", () => {
    expect(validateRequestOrigin("https://evil.example", trusted)).toBe(false);
    // The prefix/suffix shapes a naive string comparison would let through.
    expect(validateRequestOrigin("https://ui.example.com.evil.example", trusted)).toBe(false);
    expect(validateRequestOrigin("https://evil.example/?x=ui.example.com", trusted)).toBe(false);
  });

  it("rejects an absent, duplicated, opaque or unparseable Origin", () => {
    // Nothing but a browser connects to /ws, and browsers always send it — so absent fails closed
    // rather than being waved through as a non-browser client the way the CSRF guard does.
    expect(validateRequestOrigin(undefined, trusted)).toBe(false);
    expect(validateRequestOrigin("", trusted)).toBe(false);
    expect(validateRequestOrigin(["https://ui.example.com", "https://evil.example"], trusted)).toBe(false);
    // "null" is what a sandboxed iframe sends; it is an opaque origin, not a trusted one.
    expect(validateRequestOrigin("null", trusted)).toBe(false);
    expect(validateRequestOrigin("ui.example.com", trusted)).toBe(false);
  });
});

describe("checkAuth", () => {
  let tracker: AuthFailureTracker;
  beforeEach(() => {
    tracker = new AuthFailureTracker();
  });

  it("challenges when no Authorization header is present", () => {
    expect(checkAuth("ip", req(), UI, tracker)).toBe("challenge");
  });

  it("accepts correct Basic credentials and clears prior failures", () => {
    tracker.recordFailure("ip");
    expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), UI, tracker)).toBe("ok");
  });

  it("rejects a wrong password and records a failure", () => {
    const spy = vi.spyOn(tracker, "recordFailure");
    expect(checkAuth("ip", req({ authorization: basic("admin", "wrong") }), UI, tracker)).toBe("unauthorized");
    expect(spy).toHaveBeenCalledWith("ip");
  });

  it("rejects a malformed Basic payload with no colon", () => {
    const noColon = "Basic " + Buffer.from("nocolon").toString("base64");
    expect(checkAuth("ip", req({ authorization: noColon }), UI, tracker)).toBe("unauthorized");
  });

  it("returns blocked once the IP is over its failure budget", () => {
    const t = new AuthFailureTracker(1, 60_000);
    t.recordFailure("bad-ip");
    expect(checkAuth("bad-ip", req({ authorization: basic("admin", "hunter2") }), UI, t)).toBe("blocked");
  });

  it("exempts POST to the agent endpoint (Bearer API key auth)", () => {
    const r = req({ method: "POST", pathname: "/api/workspaces/ws1/agent" });
    // "exempt", never "ok": nothing about this caller has been verified here, and server.ts hands
    // out a /ws session cookie on "ok". This route is published on the DNS-direct public hostname,
    // so conflating the two would mint a working UI session for any anonymous caller.
    expect(checkAuth("ip", r, UI, tracker)).toBe("exempt");
    // ...but only for that exact route, and only for POST
    expect(checkAuth("ip", req({ method: "GET", pathname: "/api/workspaces/ws1/agent" }), UI, tracker)).toBe(
      "challenge",
    );
    expect(checkAuth("ip", req({ method: "POST", pathname: "/api/workspaces/ws1/agent/extra" }), UI, tracker)).toBe(
      "challenge",
    );
  });

  it("exempts the Workspace MCP endpoint (own Bearer secret) for every method", () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      expect(checkAuth("ip", req({ method, pathname: "/api/workspaces/ws1/mcp" }), UI, tracker)).toBe("exempt");
    }
    // ...but not the management route or a sub-path
    expect(checkAuth("ip", req({ method: "GET", pathname: "/api/workspaces/ws1/mcp-config" }), UI, tracker)).toBe(
      "challenge",
    );
    expect(checkAuth("ip", req({ method: "POST", pathname: "/api/workspaces/ws1/mcp/extra" }), UI, tracker)).toBe(
      "challenge",
    );
  });

  it("accepts a valid platform token only on explicitly shared workspace routes", () => {
    const validate = vi.fn((token: string) => token === "cli_good");
    for (const pathname of ["/api/status", "/api/workspaces", "/api/workspaces/ws-1"]) {
      expect(
        checkAuth("ip", req({ method: "GET", pathname, authorization: "Bearer cli_good" }), UI, tracker, validate),
      ).toBe("platform");
    }
    // The validator only ever sees the secret. Authorization is the policy table's job, which is why
    // the loop below denies unmapped routes while handing this same validator the same valid token.
    expect(validate).toHaveBeenCalledWith("cli_good");

    for (const [method, pathname] of [
      ["POST", "/api/workspaces"],
      ["PATCH", "/api/workspaces/ws-1"],
      ["DELETE", "/api/workspaces/ws-1"],
      // A workspace key's whole life, so an agent can replace a compromised key on its own.
      ["POST", "/api/workspaces/ws-1/api-key"],
      ["DELETE", "/api/workspaces/ws-1/api-key"],
      ["POST", "/api/workspaces/ws-1/mcp-config"],
      ["DELETE", "/api/workspaces/ws-1/mcp-config"],
      // The file surface: the tree, reading and deleting content, and the transfer pair.
      ["GET", "/api/workspaces/ws-1/files"],
      ["GET", "/api/workspaces/ws-1/files/content"],
      ["DELETE", "/api/workspaces/ws-1/files/content"],
      ["GET", "/api/workspaces/ws-1/files/transfer"],
      ["PUT", "/api/workspaces/ws-1/files/transfer"],
    ]) {
      expect(checkAuth("ip", req({ method, pathname, authorization: "Bearer cli_good" }), UI, tracker, validate)).toBe(
        "platform",
      );
    }

    for (const [method, pathname] of [
      // The browser's own transports stay UI-only — the CLI pushes and pulls through the transfer pair.
      ["POST", "/api/workspaces/ws-1/files/upload"],
      ["POST", "/api/workspaces/ws-1/files/download"],
      // The UI editor's save and its drag-and-drop move: no CLI command issues either.
      ["PUT", "/api/workspaces/ws-1/files/content"],
      ["PATCH", "/api/workspaces/ws-1/files/content"],
      // Rotate and revoke are shared; reading and toggling a channel stay UI-only.
      ["GET", "/api/workspaces/ws-1/api-key"],
      ["PATCH", "/api/workspaces/ws-1/api-key"],
      // The route that mints and rotates the platform token itself: a CLI token reaching this would
      // let a leaked credential renew itself, so it must never map to a permission.
      ["GET", "/api/settings/cli-access"],
      ["POST", "/api/settings/cli-access"],
      ["DELETE", "/api/settings/cli-access"],
    ]) {
      expect(checkAuth("ip", req({ method, pathname, authorization: "Bearer cli_good" }), UI, tracker, validate)).toBe(
        "unauthorized",
      );
    }
  });

  it("does not count an authorization denial toward the brute-force lockout", () => {
    // The tracker is shared with the UI's Basic auth. A valid token used on a route that simply is
    // not shared is a misconfigured client, not a credential guess — counting it would let a script
    // polling an unshared route lock its own operator out of the web interface. Ten attempts here is
    // twice the lockout threshold.
    const spy = vi.spyOn(tracker, "recordFailure");
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        checkAuth(
          "ip",
          req({ method: "POST", pathname: "/api/workspaces/ws-1/files/upload", authorization: "Bearer cli_good" }),
          UI,
          tracker,
          (token) => token === "cli_good",
        ),
      ).toBe("unauthorized");
    }
    expect(spy).not.toHaveBeenCalled();
    // ...and the UI's own credentials still work from that IP.
    expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), UI, tracker)).toBe("ok");
  });

  it("reads the UI credential from whichever mode is configured, never a fixed scheme", () => {
    // The seam: an assertion-header mode authenticates on `assertion` alone, and the Basic header a
    // caller might still send is not a second way in.
    const iap = assertionAuthenticator("good-token");
    expect(checkAuth("ip", req({ assertion: "good-token" }), iap, tracker)).toBe("ok");
    expect(checkAuth("ip", req({ assertion: "forged" }), iap, tracker)).toBe("unauthorized");
    expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), iap, tracker)).toBe("challenge");
  });

  it("does not let a Basic header reach an assertion mode's tracker as a guess", () => {
    // "absent" must not count: behind a proxy every unauthenticated probe looks like this, and
    // counting it would let an unauthenticated caller lock a real user out of their own instance.
    const spy = vi.spyOn(tracker, "recordFailure");
    const iap = assertionAuthenticator("good-token");
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), iap, tracker)).toBe("challenge");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid platform token and records a failure", () => {
    const spy = vi.spyOn(tracker, "recordFailure");
    const result = checkAuth(
      "ip",
      req({ method: "GET", pathname: "/api/workspaces", authorization: "Bearer cli_wrong" }),
      UI,
      tracker,
      () => false,
    );
    expect(result).toBe("unauthorized");
    expect(spy).toHaveBeenCalledWith("ip");
  });
});

describe("checkAuth host-scoping (public API gateway)", () => {
  const API = "api.example.com";
  let tracker: AuthFailureTracker;
  beforeEach(() => {
    tracker = new AuthFailureTracker();
  });

  it("refuses the shared UI password on the API host", () => {
    const r = req({ hostname: API, authorization: basic("admin", "hunter2") });
    expect(checkAuth("ip", r, UI, tracker, () => false, API)).toBe("unauthorized");
    // ...and refuses an assertion the same way, whatever the mode: nothing fronts this host.
    const iap = assertionAuthenticator("good-token");
    expect(checkAuth("ip", req({ hostname: API, assertion: "good-token" }), iap, tracker, () => false, API)).toBe(
      "unauthorized",
    );
  });

  it("refuses an unauthenticated request on the API host without a browser challenge", () => {
    expect(checkAuth("ip", req({ hostname: API }), UI, tracker, () => false, API)).toBe("unauthorized");
  });

  it("does not track the refused UI credential (all api.* traffic shares one gateway IP)", () => {
    const spy = vi.spyOn(tracker, "recordFailure");
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        checkAuth("ip", req({ hostname: API, authorization: basic("admin", "wrong") }), UI, tracker, () => false, API),
      ).toBe("unauthorized");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves the machine paths on the API host working", () => {
    const validate = (token: string) => token === "cli_good";
    expect(
      checkAuth(
        "ip",
        req({ hostname: API, method: "POST", pathname: "/api/workspaces/ws1/agent" }),
        UI,
        tracker,
        validate,
        API,
      ),
    ).toBe("exempt");
    expect(
      checkAuth(
        "ip",
        req({ hostname: API, method: "POST", pathname: "/api/workspaces/ws1/mcp" }),
        UI,
        tracker,
        validate,
        API,
      ),
    ).toBe("exempt");
    expect(
      checkAuth(
        "ip",
        req({ hostname: API, method: "GET", pathname: "/api/workspaces", authorization: "Bearer cli_good" }),
        UI,
        tracker,
        validate,
        API,
      ),
    ).toBe("platform");
  });

  it("leaves the UI host untouched — the password still works there", () => {
    const r = req({ hostname: "ui.example.com", authorization: basic("admin", "hunter2") });
    expect(checkAuth("ip", r, UI, tracker, () => false, API)).toBe("ok");
  });
});

describe("checkWsAuth", () => {
  let tracker: AuthFailureTracker;
  const accept = () => true;
  const reject = () => false;

  beforeEach(() => {
    tracker = new AuthFailureTracker();
  });

  it("accepts Basic credentials without consulting the cookie", () => {
    // Chrome and Firefox do reuse the cached credentials on a same-origin handshake, so the Basic
    // path must keep working unchanged — the cookie is a fallback, not a replacement.
    const r = req({ pathname: "/ws", authorization: basic("admin", "hunter2") });
    expect(checkWsAuth("ip", r, UI, tracker, reject)).toBe("ok");
  });

  it("accepts a valid session cookie when the handshake carries no Authorization", () => {
    // The Safari case: no credential on the upgrade at all.
    const r = req({ pathname: "/ws", cookie: "paodo_ws_session=valid" });
    expect(checkWsAuth("ip", r, UI, tracker, accept)).toBe("ok");
  });

  it("rejects when neither credential is present", () => {
    expect(checkWsAuth("ip", req({ pathname: "/ws" }), UI, tracker, reject)).toBe("challenge");
  });

  it("rejects a bad cookie the same as no cookie", () => {
    const r = req({ pathname: "/ws", cookie: "paodo_ws_session=forged" });
    expect(checkWsAuth("ip", r, UI, tracker, reject)).toBe("challenge");
  });

  it("rejects wrong Basic credentials even when they look well-formed", () => {
    const r = req({ pathname: "/ws", authorization: basic("admin", "wrong") });
    expect(checkWsAuth("ip", r, UI, tracker, reject)).toBe("unauthorized");
  });

  it("still blocks an IP over its failure budget, cookie or not", () => {
    // Otherwise a forged-cookie flood would walk straight past the brute-force lockout.
    const t = new AuthFailureTracker(1, 60_000);
    t.recordFailure("bad-ip");
    expect(checkWsAuth("bad-ip", req({ pathname: "/ws" }), UI, t, accept)).toBe("blocked");
  });

  it("authenticates an assertion-mode upgrade without any session cookie", () => {
    // server.ts passes a never-true cookie verifier in `iap` mode, so the assertion riding the
    // upgrade is the only credential — and it must be enough on its own.
    const iap = assertionAuthenticator("good-token");
    expect(checkWsAuth("ip", req({ pathname: "/ws", assertion: "good-token" }), iap, tracker, reject)).toBe("ok");
    expect(checkWsAuth("ip", req({ pathname: "/ws" }), iap, tracker, reject)).toBe("challenge");
  });

  it("does not accept the Bearer-route exemption as a pass", () => {
    // Those routes are HTTP-only and never upgrade; treating "exempt" as authenticated here would
    // let any caller open a socket by naming an exempt path.
    const r = req({ method: "POST", pathname: "/api/workspaces/ws1/agent" });
    expect(checkWsAuth("ip", r, UI, tracker, reject)).toBe("exempt");
  });

  it("refuses the session-cookie fallback on the API host", () => {
    // The cookie is a basic-mode UI credential too; a valid one must not open a socket on api.*.
    // checkAuth refuses the UI path outright there, so this is "unauthorized", never "ok".
    const r = req({ pathname: "/ws", hostname: "api.example.com", cookie: "paodo_ws_session=valid" });
    expect(checkWsAuth("ip", r, UI, tracker, accept, "api.example.com")).toBe("unauthorized");
  });
});

describe("isCsrf", () => {
  it("ignores non-mutating methods", () => {
    expect(isCsrf({ method: "GET", pathname: "/api/x", secFetchSite: "cross-site" })).toBe(false);
  });

  it("ignores non-API paths", () => {
    expect(isCsrf({ method: "POST", pathname: "/not-api", secFetchSite: "cross-site" })).toBe(false);
  });

  it("blocks a cross-site mutation to an API route", () => {
    expect(isCsrf({ method: "POST", pathname: "/api/x", secFetchSite: "cross-site" })).toBe(true);
    expect(isCsrf({ method: "DELETE", pathname: "/api/x", secFetchSite: "same-site" })).toBe(true);
  });

  it("allows same-origin and same-'none' mutations", () => {
    expect(isCsrf({ method: "POST", pathname: "/api/x", secFetchSite: "same-origin" })).toBe(false);
    expect(isCsrf({ method: "POST", pathname: "/api/x", secFetchSite: "none" })).toBe(false);
  });

  it("allows requests with no Sec-Fetch-Site header (non-browser clients)", () => {
    expect(isCsrf({ method: "POST", pathname: "/api/x", secFetchSite: undefined })).toBe(false);
  });
});

describe("authRequestFromIncoming / getClientIp", () => {
  it("extracts method, pathname (stripping query), authorization, cookie and the validated host", () => {
    const r = authRequestFromIncoming(
      {
        method: "POST",
        url: "/api/x?y=1",
        headers: { authorization: "Basic zzz", cookie: "a=1; b=2" },
      } as never,
      null,
      "api.example.com",
      true,
    );
    expect(r).toEqual({
      method: "POST",
      pathname: "/api/x",
      authorization: "Basic zzz",
      cookie: "a=1; b=2",
      assertion: "",
      hostname: "api.example.com",
      isUpgrade: true,
    });
  });

  it("defaults missing headers to empty strings, and the host and upgrade flag to their safe values", () => {
    // isUpgrade must default false: it is what lets a mode read a cookie, and only /ws may.
    const r = authRequestFromIncoming({ method: "GET", url: "/", headers: {} } as never);
    expect(r).toEqual({
      method: "GET",
      pathname: "/",
      authorization: "",
      cookie: "",
      assertion: "",
      hostname: "",
      isUpgrade: false,
    });
  });

  it("reads the assertion only from the header the mode names, and ignores a repeated one", () => {
    const headers = { "x-assertion": "token", "cf-access-jwt-assertion": "other" };
    const named = authRequestFromIncoming({ method: "GET", url: "/", headers } as never, "x-assertion");
    expect(named.assertion).toBe("token");
    // No configured header (Basic mode): nothing is read, so a caller cannot smuggle one in.
    expect(authRequestFromIncoming({ method: "GET", url: "/", headers } as never).assertion).toBe("");
    // Two copies means someone appended to the proxy's value — fail closed rather than pick one.
    // Node joins them into one comma-separated string; the array shape is defensive, only set-cookie.
    for (const duplicated of ["token, forged", ["token", "forged"]]) {
      const headers = { "x-assertion": duplicated };
      expect(authRequestFromIncoming({ method: "GET", url: "/", headers } as never, "x-assertion").assertion).toBe("");
    }
  });

  it("prefers cf-connecting-ip, falling back to the socket peer", () => {
    expect(
      getClientIp({ headers: { "cf-connecting-ip": "9.9.9.9" }, socket: { remoteAddress: "1.2.3.4" } } as never),
    ).toBe("9.9.9.9");
    expect(getClientIp({ headers: {}, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("1.2.3.4");
    expect(getClientIp({ headers: {}, socket: {} } as never)).toBe("unknown");
  });

  it("refuses a forwarded loopback address, which would waive every rate limit", () => {
    // No edge sees a real client at a loopback address, and RateLimiter exempts one — so honouring
    // this would let any caller opt out of every limit in the application with one header.
    for (const spoofed of ["127.0.0.1", "::1", "::ffff:127.0.0.1", " 127.0.0.1 "]) {
      const headers = { "cf-connecting-ip": spoofed };
      expect(getClientIp({ headers, socket: { remoteAddress: "172.18.0.5" } } as never)).toBe("172.18.0.5");
    }
  });

  it("ignores client-supplied forwarding headers", () => {
    // Nothing in the chain sets these, so a caller can put anything in them. Trusting one puts an
    // attacker-chosen address in the audit trail and lets them rotate past the brute-force lockout.
    const spoofed = { "x-real-ip": "203.0.113.99", "x-forwarded-for": "203.0.113.99" };
    expect(getClientIp({ headers: spoofed, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("1.2.3.4");
  });
});
