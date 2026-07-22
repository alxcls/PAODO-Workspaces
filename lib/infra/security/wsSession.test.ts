// This cookie is a credential: it is the only thing standing between an unauthenticated caller and
// a /ws upgrade on browsers that cannot present Basic on a handshake. The dangerous failure is
// verifySessionCookie returning true for anything the server did not mint, so every malformed and
// forged shape is asserted false. The attribute assertions matter for the same reason — a cookie
// without HttpOnly is readable by injected script, and one without SameSite rides cross-site
// requests.
import { describe, it, expect, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  mintSessionCookie,
  sessionCookieNeedsRefresh,
  sessionExpiry,
  verifySessionCookie,
} from "./wsSession";

// Turns a Set-Cookie value into the Cookie header a browser would send back.
function asCookieHeader(setCookie: string): string {
  return setCookie.split(";")[0];
}

const mint = (isProduction = false) => asCookieHeader(mintSessionCookie({ isProduction }));

describe("mintSessionCookie", () => {
  it("sets the attributes that keep the cookie out of script and off cross-site requests", () => {
    const cookie = mintSessionCookie({ isProduction: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("marks the cookie Secure only in production", () => {
    // Dev serves over plain http; a Secure cookie would be dropped and the socket would never
    // authenticate locally.
    expect(mintSessionCookie({ isProduction: true })).toContain("Secure");
    expect(mintSessionCookie({ isProduction: false })).not.toContain("Secure");
  });
});

describe("verifySessionCookie", () => {
  it("accepts a freshly minted cookie", () => {
    expect(verifySessionCookie(mint())).toBe(true);
  });

  it("finds the cookie among others in the header", () => {
    expect(verifySessionCookie(`other=1; ${mint()}; another=2`)).toBe(true);
  });

  it("rejects an absent or empty header", () => {
    expect(verifySessionCookie(undefined)).toBe(false);
    expect(verifySessionCookie("")).toBe(false);
    expect(verifySessionCookie("other=1; another=2")).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=`)).toBe(false);
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=nodothere`)).toBe(false);
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=.`)).toBe(false);
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=abc.def`)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const [payload, sig] = mint().split("=")[1].split(".");
    const flipped = sig.slice(0, -1) + (sig.at(-1) === "0" ? "1" : "0");
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=${payload}.${flipped}`)).toBe(false);
  });

  it("rejects a truncated signature rather than comparing a prefix", () => {
    const [payload, sig] = mint().split("=")[1].split(".");
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=${payload}.${sig.slice(0, -2)}`)).toBe(false);
  });

  it("rejects an extended expiry carrying the original signature", () => {
    // The forgery that matters: keep a real signature, push the expiry out.
    const [payload, sig] = mint().split("=")[1].split(".");
    const later = String(Number(payload) + 86_400_000);
    expect(verifySessionCookie(`${SESSION_COOKIE_NAME}=${later}.${sig}`)).toBe(false);
  });

  it("rejects a cookie whose expiry has passed", () => {
    vi.useFakeTimers();
    try {
      const cookie = mint();
      expect(verifySessionCookie(cookie)).toBe(true);
      vi.advanceTimersByTime(13 * 60 * 60 * 1000);
      expect(verifySessionCookie(cookie)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sessionExpiry", () => {
  it("returns the signed expiry for a valid cookie and null otherwise", () => {
    const before = Date.now();
    const exp = sessionExpiry(mint());
    expect(exp).not.toBeNull();
    expect(exp as number).toBeGreaterThan(before);
    expect(sessionExpiry("garbage")).toBeNull();
  });
});

describe("sessionCookieNeedsRefresh", () => {
  it("is true with no cookie and false right after minting", () => {
    expect(sessionCookieNeedsRefresh(undefined)).toBe(true);
    expect(sessionCookieNeedsRefresh(mint())).toBe(false);
  });

  it("becomes true as the cookie approaches expiry, so an open socket is not cut off", () => {
    vi.useFakeTimers();
    try {
      const cookie = mint();
      vi.advanceTimersByTime(11 * 60 * 60 * 1000 + 1000); // inside the last hour of a 12h TTL
      expect(sessionCookieNeedsRefresh(cookie)).toBe(true);
      expect(verifySessionCookie(cookie)).toBe(true); // still valid, just due for refresh
    } finally {
      vi.useRealTimers();
    }
  });
});
