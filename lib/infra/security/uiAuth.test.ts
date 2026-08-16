// The mode seam. The dangerous failures are a mode that authenticates something it should not
// (unset credentials, an unverified assertion) and a misconfiguration that resolves instead of
// throwing — a deployment that boots with the wrong mode is one that guards nothing.
import { describe, it, expect } from "vitest";

import { basicAuthenticator, resolveUiAuth, safeEqual, type UiAuthEnvironment } from "./uiAuth";
import { JwksCache } from "./iapAssertion";

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function input(partial: Partial<{ authorization: string; cookie: string; assertion: string }> = {}) {
  return { authorization: "", cookie: "", assertion: "", ...partial };
}

const IAP_ENV: UiAuthEnvironment = {
  PAODO_AUTH_MODE: "iap",
  PAODO_IAP_HEADER: "Cf-Access-Jwt-Assertion",
  PAODO_IAP_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  PAODO_IAP_ISSUER: "https://team.cloudflareaccess.com",
  PAODO_IAP_AUDIENCE: "aud-tag",
};

// Never reached: no test here lets a token get as far as a key lookup.
const stubJwks = () => new JwksCache("https://example.test/certs", 0, () => Promise.resolve({ keys: [] }));

describe("safeEqual", () => {
  it("returns true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // length mismatch path
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("basicAuthenticator", () => {
  const auth = basicAuthenticator({ user: "admin", pass: "hunter2" });

  it("distinguishes a missing credential from a wrong one", () => {
    // The split drives the lockout: "absent" is an ordinary first request, "invalid" is a guess.
    expect(auth.verify(input())).toBe("absent");
    expect(auth.verify(input({ authorization: "Bearer x" }))).toBe("absent");
    expect(auth.verify(input({ authorization: basic("admin", "hunter2") }))).toBe("ok");
    expect(auth.verify(input({ authorization: basic("admin", "wrong") }))).toBe("invalid");
    expect(auth.verify(input({ authorization: "Basic " + Buffer.from("nocolon").toString("base64") }))).toBe("invalid");
  });

  it("refuses to match unset credentials against an empty Basic header", () => {
    // safeEqual("", "") is true, so an empty pair must fail before the comparison. resolveUiAuth
    // already refuses to build this; the guard is the second line, not the only one.
    const unset = basicAuthenticator({ user: "", pass: "" });
    expect(unset.verify(input({ authorization: basic("", "") }))).toBe("invalid");
  });

  it("offers a Basic challenge and reads no assertion header", () => {
    expect(auth.challenge).toBe('Basic realm="App"');
    expect(auth.assertionHeader).toBeNull();
  });
});

describe("resolveUiAuth", () => {
  it("defaults to basic, so an unset variable never selects the mode needing an external service", () => {
    const auth = resolveUiAuth({ USERNAME: "admin", PASSWORD: "hunter2" });
    expect(auth.mode).toBe("basic");
  });

  it("refuses to build a mode that is not fully configured", () => {
    expect(() => resolveUiAuth({ USERNAME: "admin" })).toThrow("USERNAME and PASSWORD are required");
    expect(() => resolveUiAuth({ PASSWORD: "hunter2" })).toThrow("USERNAME and PASSWORD are required");
    expect(() => resolveUiAuth({ PAODO_AUTH_MODE: "sso", USERNAME: "a", PASSWORD: "b" })).toThrow(
      'PAODO_AUTH_MODE must be "basic" or "iap"',
    );
    for (const missing of ["PAODO_IAP_HEADER", "PAODO_IAP_JWKS_URL", "PAODO_IAP_ISSUER", "PAODO_IAP_AUDIENCE"]) {
      expect(() => resolveUiAuth({ ...IAP_ENV, [missing]: "" }, stubJwks)).toThrow(missing);
    }
  });

  it("rejects a plaintext or malformed JWKS URL", () => {
    // Over http the key set is whatever the network says it is, which makes every later check moot.
    const http = { ...IAP_ENV, PAODO_IAP_JWKS_URL: "http://team.example.com/certs" };
    expect(() => resolveUiAuth(http, stubJwks)).toThrow("must be https");
    expect(() => resolveUiAuth({ ...IAP_ENV, PAODO_IAP_JWKS_URL: "not-a-url" }, stubJwks)).toThrow("not a valid URL");
  });

  it("rejects a header name that is not a single token", () => {
    expect(() => resolveUiAuth({ ...IAP_ENV, PAODO_IAP_HEADER: "X-Bad Header" }, stubJwks)).toThrow(
      "not a valid header name",
    );
  });

  it("lowercases the assertion header to match what Node exposes", () => {
    const auth = resolveUiAuth(IAP_ENV, stubJwks);
    expect(auth.mode).toBe("iap");
    expect(auth.assertionHeader).toBe("cf-access-jwt-assertion");
  });

  it("offers no challenge in iap mode", () => {
    // A WWW-Authenticate here would prompt for a credential this mode does not accept, and the
    // browser dialog it opens can never satisfy the request.
    expect(resolveUiAuth(IAP_ENV, stubJwks).challenge).toBeNull();
  });

  it("treats an absent assertion as absent and an unverifiable one as invalid", () => {
    const auth = resolveUiAuth(IAP_ENV, stubJwks);
    expect(auth.verify(input())).toBe("absent");
    // Basic credentials are not a fallback: in iap mode the shared password does not exist.
    expect(auth.verify(input({ authorization: basic("admin", "hunter2") }))).toBe("absent");
    expect(auth.verify(input({ assertion: "not.a.jwt" }))).toBe("invalid");
  });

  it("falls back to the configured cookie, and only when one is configured", () => {
    const withCookie = resolveUiAuth({ ...IAP_ENV, PAODO_IAP_COOKIE: "CF_Authorization" }, stubJwks);
    expect(withCookie.verify(input({ cookie: "CF_Authorization=not.a.jwt" }))).toBe("invalid");
    expect(withCookie.verify(input({ cookie: "other=not.a.jwt" }))).toBe("absent");
    expect(resolveUiAuth(IAP_ENV, stubJwks).verify(input({ cookie: "CF_Authorization=not.a.jwt" }))).toBe("absent");
  });
});
