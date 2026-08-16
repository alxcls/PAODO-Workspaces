// This is the only thing standing between "a header said so" and an authenticated session, so the
// tests are written around forgeries rather than the happy path: a wrong audience, a swapped key, an
// algorithm the token chose for itself, a payload edited after signing.
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "crypto";

import { JwksCache, verifyAssertion, type AssertionPolicy } from "./iapAssertion";

const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "aud-tag";
const NOW = 1_700_000_000_000;

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid };
  return { privateKey, jwk };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  privateKey: KeyObject,
  { header = {}, claims = {} }: { header?: Record<string, unknown>; claims?: Record<string, unknown> } = {},
): string {
  const body = `${encode({ alg: "RS256", kid: "k1", ...header })}.${encode({
    iss: ISSUER,
    aud: AUDIENCE,
    email: "person@example.com",
    exp: NOW / 1000 + 3600,
    ...claims,
  })}`;
  const signature = cryptoSign("sha256", Buffer.from(body, "ascii"), privateKey);
  return `${body}.${signature.toString("base64url")}`;
}

function policyFor(jwk: unknown, minRefreshMs = 0): { policy: AssertionPolicy; fetches: () => number } {
  let fetches = 0;
  const jwks = new JwksCache("https://example.test/certs", minRefreshMs, () => {
    fetches++;
    return Promise.resolve({ keys: [jwk] });
  });
  return { policy: { issuer: ISSUER, audience: AUDIENCE, jwks }, fetches: () => fetches };
}

describe("JwksCache", () => {
  it("fails a refresh that yields no usable key, so startup can stop", () => {
    const empty = new JwksCache("https://example.test/certs", 0, () => Promise.resolve({ keys: [] }));
    return expect(empty.refresh()).rejects.toThrow("no usable keys");
  });

  it("keeps the usable keys in a set that also contains a broken entry", async () => {
    const { jwk } = keypair("k1");
    const mixed = new JwksCache("https://example.test/certs", 0, () =>
      Promise.resolve({ keys: [{ kid: "bad", kty: "RSA" }, jwk, { kty: "RSA" }] }),
    );
    await mixed.refresh();
    expect(mixed.size).toBe(1);
  });

  it("propagates an unreachable endpoint rather than caching an empty set", () => {
    const down = new JwksCache("https://example.test/certs", 0, () => Promise.reject(new Error("ECONNREFUSED")));
    return expect(down.refresh()).rejects.toThrow("ECONNREFUSED");
  });
});

describe("verifyAssertion", () => {
  it("accepts a token signed by a published key for this issuer and audience", async () => {
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(privateKey), policy, NOW)).toBe(true);
  });

  it("accepts an audience array that contains this instance", async () => {
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(privateKey, { claims: { aud: ["other", AUDIENCE] } }), policy, NOW)).toBe(true);
  });

  it("rejects a token minted for a different application of the same issuer", async () => {
    // The isolation that matters when several deployments share one identity provider: without the
    // audience check, any of them mints a token that authenticates against all the others.
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(privateKey, { claims: { aud: "someone-elses-tag" } }), policy, NOW)).toBe(false);
    expect(verifyAssertion(token(privateKey, { claims: { aud: ["a", "b"] } }), policy, NOW)).toBe(false);
    expect(verifyAssertion(token(privateKey, { claims: { aud: undefined } }), policy, NOW)).toBe(false);
  });

  it("rejects a different issuer, even correctly signed by a key this cache holds", async () => {
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(privateKey, { claims: { iss: "https://evil.example" } }), policy, NOW)).toBe(false);
  });

  it("rejects a token signed by a key the provider never published", async () => {
    const { jwk } = keypair("k1");
    const other = keypair("k1"); // same kid, attacker's key
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(other.privateKey), policy, NOW)).toBe(false);
  });

  it("rejects a payload edited after signing", async () => {
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    const [header, , signature] = token(privateKey).split(".");
    const swapped = encode({ iss: ISSUER, aud: AUDIENCE, email: "admin@example.com", exp: NOW / 1000 + 3600 });
    expect(verifyAssertion(`${header}.${swapped}.${signature}`, policy, NOW)).toBe(false);
  });

  it("rejects an algorithm the token chose for itself", async () => {
    // "none" and HMAC-with-the-public-key are the classic bypasses: both are refused by the closed
    // table before any key is looked up, so a token cannot nominate how it will be checked.
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    for (const alg of ["none", "HS256", "RS1", ""]) {
      expect(verifyAssertion(token(privateKey, { header: { alg } }), policy, NOW)).toBe(false);
    }
    const [, payload, signature] = token(privateKey).split(".");
    expect(verifyAssertion(`${encode({ kid: "k1" })}.${payload}.${signature}`, policy, NOW)).toBe(false);
  });

  it("rejects an expired token and one that is not yet valid, allowing a minute of skew", async () => {
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    const expiredAt = NOW / 1000 - 3600;
    expect(verifyAssertion(token(privateKey, { claims: { exp: expiredAt } }), policy, NOW)).toBe(false);
    // Just inside the skew window on each side.
    expect(verifyAssertion(token(privateKey, { claims: { exp: NOW / 1000 - 30 } }), policy, NOW)).toBe(true);
    expect(verifyAssertion(token(privateKey, { claims: { nbf: NOW / 1000 + 30 } }), policy, NOW)).toBe(true);
    expect(verifyAssertion(token(privateKey, { claims: { nbf: NOW / 1000 + 600 } }), policy, NOW)).toBe(false);
  });

  it("rejects a token with no expiry at all", async () => {
    // A missing `exp` must not read as "never expires" — that is a permanent credential in a header.
    const { privateKey, jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    expect(verifyAssertion(token(privateKey, { claims: { exp: undefined } }), policy, NOW)).toBe(false);
    expect(verifyAssertion(token(privateKey, { claims: { exp: "later" } }), policy, NOW)).toBe(false);
  });

  it("rejects anything that is not a three-part JWS", async () => {
    const { jwk } = keypair("k1");
    const { policy } = policyFor(jwk);
    await policy.jwks.refresh();
    for (const malformed of ["", "a", "a.b", "a.b.c.d", "...", "not.a.jwt"]) {
      expect(verifyAssertion(malformed, policy, NOW)).toBe(false);
    }
  });

  it("fails an unknown kid on the spot and refreshes at most once per window", async () => {
    // An attacker who could force a fetch per request would have an amplifier; a real rotation costs
    // one failed request and is served from the refreshed set afterwards.
    const { privateKey, jwk } = keypair("k1");
    const { policy, fetches } = policyFor(jwk, 60_000);
    await policy.jwks.refresh();
    expect(fetches()).toBe(1);

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(verifyAssertion(token(privateKey, { header: { kid: "unknown" } }), policy, NOW)).toBe(false);
    }
    await vi.waitFor(() => expect(fetches()).toBe(1)); // still within the window: no extra fetch
  });
});
