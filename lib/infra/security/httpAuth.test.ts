// These guards front every request to the app. The dangerous failures are the inverse of each
// function's job: checkAuth returning "ok" for a bad/absent credential, and isCsrf returning false
// for a genuine cross-site mutation. Tests lock down both directions.
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  AuthFailureTracker,
  checkAuth,
  checkWsAuth,
  isCsrf,
  safeEqual,
  authRequestFromIncoming,
  getClientIp,
  trustedRequestHosts,
  type AuthRequest,
  validateRequestHost,
} from "./httpAuth";

const CREDS = { user: "admin", pass: "hunter2" };

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function req(partial: Partial<AuthRequest> = {}): AuthRequest {
  return { method: "GET", pathname: "/", authorization: "", cookie: "", ...partial };
}

describe("safeEqual", () => {
  it("returns true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // length mismatch path
    expect(safeEqual("", "")).toBe(true);
  });
});

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

describe("checkAuth", () => {
  let tracker: AuthFailureTracker;
  beforeEach(() => {
    tracker = new AuthFailureTracker();
  });

  // safeEqual("", "") is true, so unset credentials must fail closed before the comparison.
  it("rejects unset credentials instead of matching them against an empty Basic header", () => {
    expect(checkAuth("ip", req({ authorization: basic("", "") }), { user: "", pass: "" }, tracker)).toBe(
      "unauthorized",
    );
  });

  it("challenges when no Authorization header is present", () => {
    expect(checkAuth("ip", req(), CREDS, tracker)).toBe("challenge");
  });

  it("accepts correct Basic credentials and clears prior failures", () => {
    tracker.recordFailure("ip");
    expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), CREDS, tracker)).toBe("ok");
  });

  it("rejects a wrong password and records a failure", () => {
    const spy = vi.spyOn(tracker, "recordFailure");
    expect(checkAuth("ip", req({ authorization: basic("admin", "wrong") }), CREDS, tracker)).toBe("unauthorized");
    expect(spy).toHaveBeenCalledWith("ip");
  });

  it("rejects a malformed Basic payload with no colon", () => {
    const noColon = "Basic " + Buffer.from("nocolon").toString("base64");
    expect(checkAuth("ip", req({ authorization: noColon }), CREDS, tracker)).toBe("unauthorized");
  });

  it("returns blocked once the IP is over its failure budget", () => {
    const t = new AuthFailureTracker(1, 60_000);
    t.recordFailure("bad-ip");
    expect(checkAuth("bad-ip", req({ authorization: basic("admin", "hunter2") }), CREDS, t)).toBe("blocked");
  });

  it("exempts POST to the agent endpoint (Bearer API key auth)", () => {
    const r = req({ method: "POST", pathname: "/api/workspaces/ws1/agent" });
    // "exempt", never "ok": nothing about this caller has been verified here, and server.ts hands
    // out a /ws session cookie on "ok". This route is published on the DNS-direct public hostname,
    // so conflating the two would mint a working UI session for any anonymous caller.
    expect(checkAuth("ip", r, CREDS, tracker)).toBe("exempt");
    // ...but only for that exact route, and only for POST
    expect(checkAuth("ip", req({ method: "GET", pathname: "/api/workspaces/ws1/agent" }), CREDS, tracker)).toBe(
      "challenge",
    );
    expect(checkAuth("ip", req({ method: "POST", pathname: "/api/workspaces/ws1/agent/extra" }), CREDS, tracker)).toBe(
      "challenge",
    );
  });

  it("exempts the Workspace MCP endpoint (own Bearer secret) for every method", () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      expect(checkAuth("ip", req({ method, pathname: "/api/workspaces/ws1/mcp" }), CREDS, tracker)).toBe("exempt");
    }
    // ...but not the management route or a sub-path
    expect(checkAuth("ip", req({ method: "GET", pathname: "/api/workspaces/ws1/mcp-config" }), CREDS, tracker)).toBe(
      "challenge",
    );
    expect(checkAuth("ip", req({ method: "POST", pathname: "/api/workspaces/ws1/mcp/extra" }), CREDS, tracker)).toBe(
      "challenge",
    );
  });

  it("accepts a valid platform token only on explicitly shared workspace routes", () => {
    const validate = vi.fn((token: string) => token === "cli_good");
    for (const pathname of ["/api/status", "/api/workspaces", "/api/workspaces/ws-1"]) {
      expect(
        checkAuth("ip", req({ method: "GET", pathname, authorization: "Bearer cli_good" }), CREDS, tracker, validate),
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
      expect(
        checkAuth("ip", req({ method, pathname, authorization: "Bearer cli_good" }), CREDS, tracker, validate),
      ).toBe("platform");
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
      expect(
        checkAuth("ip", req({ method, pathname, authorization: "Bearer cli_good" }), CREDS, tracker, validate),
      ).toBe("unauthorized");
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
          CREDS,
          tracker,
          (token) => token === "cli_good",
        ),
      ).toBe("unauthorized");
    }
    expect(spy).not.toHaveBeenCalled();
    // ...and the UI's own credentials still work from that IP.
    expect(checkAuth("ip", req({ authorization: basic("admin", "hunter2") }), CREDS, tracker)).toBe("ok");
  });

  it("rejects an invalid platform token and records a failure", () => {
    const spy = vi.spyOn(tracker, "recordFailure");
    const result = checkAuth(
      "ip",
      req({ method: "GET", pathname: "/api/workspaces", authorization: "Bearer cli_wrong" }),
      CREDS,
      tracker,
      () => false,
    );
    expect(result).toBe("unauthorized");
    expect(spy).toHaveBeenCalledWith("ip");
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
    expect(checkWsAuth("ip", r, CREDS, tracker, reject)).toBe("ok");
  });

  it("accepts a valid session cookie when the handshake carries no Authorization", () => {
    // The Safari case: no credential on the upgrade at all.
    const r = req({ pathname: "/ws", cookie: "paodo_ws_session=valid" });
    expect(checkWsAuth("ip", r, CREDS, tracker, accept)).toBe("ok");
  });

  it("rejects when neither credential is present", () => {
    expect(checkWsAuth("ip", req({ pathname: "/ws" }), CREDS, tracker, reject)).toBe("challenge");
  });

  it("rejects a bad cookie the same as no cookie", () => {
    const r = req({ pathname: "/ws", cookie: "paodo_ws_session=forged" });
    expect(checkWsAuth("ip", r, CREDS, tracker, reject)).toBe("challenge");
  });

  it("rejects wrong Basic credentials even when they look well-formed", () => {
    const r = req({ pathname: "/ws", authorization: basic("admin", "wrong") });
    expect(checkWsAuth("ip", r, CREDS, tracker, reject)).toBe("unauthorized");
  });

  it("still blocks an IP over its failure budget, cookie or not", () => {
    // Otherwise a forged-cookie flood would walk straight past the brute-force lockout.
    const t = new AuthFailureTracker(1, 60_000);
    t.recordFailure("bad-ip");
    expect(checkWsAuth("bad-ip", req({ pathname: "/ws" }), CREDS, t, accept)).toBe("blocked");
  });

  it("does not accept the Bearer-route exemption as a pass", () => {
    // Those routes are HTTP-only and never upgrade; treating "exempt" as authenticated here would
    // let any caller open a socket by naming an exempt path.
    const r = req({ method: "POST", pathname: "/api/workspaces/ws1/agent" });
    expect(checkWsAuth("ip", r, CREDS, tracker, reject)).toBe("exempt");
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
  it("extracts method, pathname (stripping query), authorization and cookie", () => {
    const r = authRequestFromIncoming({
      method: "POST",
      url: "/api/x?y=1",
      headers: { authorization: "Basic zzz", cookie: "a=1; b=2" },
    } as never);
    expect(r).toEqual({ method: "POST", pathname: "/api/x", authorization: "Basic zzz", cookie: "a=1; b=2" });
  });

  it("defaults missing headers to empty strings rather than undefined", () => {
    const r = authRequestFromIncoming({ method: "GET", url: "/", headers: {} } as never);
    expect(r).toEqual({ method: "GET", pathname: "/", authorization: "", cookie: "" });
  });

  it("prefers cf-connecting-ip, falling back to the socket peer", () => {
    expect(
      getClientIp({ headers: { "cf-connecting-ip": "9.9.9.9" }, socket: { remoteAddress: "1.2.3.4" } } as never),
    ).toBe("9.9.9.9");
    expect(getClientIp({ headers: {}, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("1.2.3.4");
    expect(getClientIp({ headers: {}, socket: {} } as never)).toBe("unknown");
  });

  it("ignores client-supplied forwarding headers", () => {
    // Nothing in the chain sets these, so a caller can put anything in them. Trusting one puts an
    // attacker-chosen address in the audit trail and lets them rotate past the brute-force lockout.
    const spoofed = { "x-real-ip": "203.0.113.99", "x-forwarded-for": "203.0.113.99" };
    expect(getClientIp({ headers: spoofed, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("1.2.3.4");
  });
});
