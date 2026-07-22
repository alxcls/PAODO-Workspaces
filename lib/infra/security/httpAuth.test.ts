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
  type AuthRequest,
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
