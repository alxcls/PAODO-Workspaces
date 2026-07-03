// The credential proxy's whole job is to swap opaque placeholder tokens for real secret values
// wherever they ride in an HTTP request. These pin the two non-obvious substitution paths that a
// plain substring replace misses: base64-wrapped Basic auth, and chunked request-body decoding.

import { describe, it, expect } from "vitest";
import { substituteHeaderValue, decodeChunked, hostMatches } from "./credentialProxy";

const TOKEN = "__pxy_ws1_OPENAI_API_KEY__";
const REAL = "sk-realsecret123";
const tokenMap = new Map([[TOKEN, REAL]]);

describe("substituteHeaderValue", () => {
  it("substitutes a token that appears verbatim (Bearer)", () => {
    expect(substituteHeaderValue(`Bearer ${TOKEN}`, tokenMap)).toBe(`Bearer ${REAL}`);
  });

  it("substitutes inside base64-encoded Basic auth", () => {
    const header = "Basic " + Buffer.from(`user:${TOKEN}`).toString("base64");
    const out = substituteHeaderValue(header, tokenMap);
    const decoded = Buffer.from(out.replace(/^Basic /, ""), "base64").toString();
    expect(decoded).toBe(`user:${REAL}`);
    expect(out).not.toContain(TOKEN);
  });

  it("substitutes a Basic token used as the username (token:)", () => {
    const header = "Basic " + Buffer.from(`${TOKEN}:`).toString("base64");
    const decoded = Buffer.from(
      substituteHeaderValue(header, tokenMap).replace(/^Basic /, ""),
      "base64",
    ).toString();
    expect(decoded).toBe(`${REAL}:`);
  });

  it("leaves values without a token untouched", () => {
    expect(substituteHeaderValue("application/json", tokenMap)).toBe("application/json");
  });

  it("does not corrupt a Basic header whose payload isn't valid base64", () => {
    // No token present and not decodable — must pass through unchanged, not throw.
    expect(substituteHeaderValue("Basic not*base64*here", tokenMap)).toBe("Basic not*base64*here");
  });
});

describe("hostMatches (exact-host scoping)", () => {
  it("matches the exact host", () => {
    expect(hostMatches("api.openai.com", "api.openai.com")).toBe(true);
  });

  it("is case-insensitive on the request host", () => {
    expect(hostMatches("API.OpenAI.com", "api.openai.com")).toBe(true);
  });

  it("does NOT match a subdomain of the scoped host", () => {
    expect(hostMatches("evil.api.openai.com", "api.openai.com")).toBe(false);
  });

  it("does NOT let an apex rule cover a subdomain", () => {
    expect(hostMatches("api.openai.com", "openai.com")).toBe(false);
  });

  it("does not match unrelated hosts", () => {
    expect(hostMatches("api.evil.com", "api.openai.com")).toBe(false);
  });
});

describe("decodeChunked", () => {
  it("decodes a complete chunked body and reports done", () => {
    const raw = Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", "latin1");
    const { body, done } = decodeChunked(raw);
    expect(body.toString()).toBe("hello world");
    expect(done).toBe(true);
  });

  it("reports not-done when the terminating chunk hasn't arrived", () => {
    const raw = Buffer.from("5\r\nhello\r\n", "latin1");
    const { body, done } = decodeChunked(raw);
    expect(body.toString()).toBe("hello");
    expect(done).toBe(false);
  });

  it("waits for an incomplete chunk rather than emitting partial data", () => {
    const raw = Buffer.from("5\r\nhel", "latin1"); // declared 5 bytes, only 3 present
    const { body, done } = decodeChunked(raw);
    expect(body.length).toBe(0);
    expect(done).toBe(false);
  });

  it("handles an empty chunked body", () => {
    const { body, done } = decodeChunked(Buffer.from("0\r\n\r\n", "latin1"));
    expect(body.length).toBe(0);
    expect(done).toBe(true);
  });
});
