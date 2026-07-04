// These guards front every request to the app. The dangerous failures are the inverse of each
// function's job: checkAuth returning "ok" for a bad/absent credential, and isCsrf returning false
// for a genuine cross-site mutation. Tests lock down both directions.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Pin the preview-token secret before httpAuth (via previewToken → paths) reads it at import time,
// so the preview-token bypass cases are deterministic.
vi.hoisted(() => {
  process.env.PREVIEW_TOKEN_SECRET = "test-secret-for-httpauth";
});

import {
  AuthFailureTracker,
  checkAuth,
  isCsrf,
  safeEqual,
  authRequestFromIncoming,
  getClientIp,
  type AuthRequest,
} from "./httpAuth";
import { getPreviewToken } from "./previewToken";

const CREDS = { user: "admin", pass: "hunter2" };

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function req(partial: Partial<AuthRequest> = {}): AuthRequest {
  return { method: "GET", pathname: "/", authorization: "", ...partial };
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

  it("is disabled (allows all) when no credentials are configured", () => {
    expect(checkAuth("ip", req({ pathname: "/anything" }), { user: "", pass: "" }, tracker)).toBe("ok");
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
    expect(checkAuth("ip", r, CREDS, tracker)).toBe("ok");
    // ...but only for that exact route, and only for POST
    expect(checkAuth("ip", req({ method: "GET", pathname: "/api/workspaces/ws1/agent" }), CREDS, tracker)).toBe("challenge");
    expect(checkAuth("ip", req({ method: "POST", pathname: "/api/workspaces/ws1/agent/extra" }), CREDS, tracker)).toBe("challenge");
  });

  describe("preview-token bypass", () => {
    it("accepts a valid proxy Bearer token for the matching workspace", () => {
      const token = getPreviewToken("wsA");
      const r = req({ method: "GET", pathname: "/api/workspaces/wsA/proxy/foo", authorization: `Bearer ${token}` });
      expect(checkAuth("ip", r, CREDS, tracker)).toBe("ok");
    });

    it("rejects a proxy token minted for a different workspace", () => {
      const token = getPreviewToken("wsA");
      const r = req({ method: "GET", pathname: "/api/workspaces/wsB/proxy/foo", authorization: `Bearer ${token}` });
      expect(checkAuth("ip", r, CREDS, tracker)).toBe("challenge");
    });

    it("lets a proxy CORS preflight (OPTIONS) through", () => {
      const r = req({ method: "OPTIONS", pathname: "/api/workspaces/wsA/proxy/foo" });
      expect(checkAuth("ip", r, CREDS, tracker)).toBe("ok");
    });

    it("accepts a valid serve token embedded in the path", () => {
      const token = getPreviewToken("wsA");
      const r = req({ method: "GET", pathname: `/api/workspaces/wsA/serve/${token}/index.js` });
      expect(checkAuth("ip", r, CREDS, tracker)).toBe("ok");
    });

    it("rejects a serve token for the wrong workspace", () => {
      const token = getPreviewToken("wsA");
      const r = req({ method: "GET", pathname: `/api/workspaces/wsB/serve/${token}/index.js` });
      expect(checkAuth("ip", r, CREDS, tracker)).toBe("challenge");
    });
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

  it("exempts token-gated proxy routes", () => {
    expect(isCsrf({ method: "POST", pathname: "/api/workspaces/w/proxy/foo", secFetchSite: "cross-site" })).toBe(false);
  });
});

describe("authRequestFromIncoming / getClientIp", () => {
  it("extracts method, pathname (stripping query), and authorization", () => {
    const r = authRequestFromIncoming({
      method: "POST",
      url: "/api/x?y=1",
      headers: { authorization: "Basic zzz" },
    } as never);
    expect(r).toEqual({ method: "POST", pathname: "/api/x", authorization: "Basic zzz" });
  });

  it("prefers x-real-ip, falling back to the socket peer", () => {
    expect(getClientIp({ headers: { "x-real-ip": "9.9.9.9" }, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("9.9.9.9");
    expect(getClientIp({ headers: {}, socket: { remoteAddress: "1.2.3.4" } } as never)).toBe("1.2.3.4");
    expect(getClientIp({ headers: {}, socket: {} } as never)).toBe("unknown");
  });
});
