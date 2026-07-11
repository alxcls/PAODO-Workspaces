// The credential proxy's whole job is to swap opaque placeholder tokens for real secret values
// wherever they ride in an HTTP request. These pin the two non-obvious substitution paths that a
// plain substring replace misses: base64-wrapped Basic auth, and chunked request-body decoding —
// plus the response direction: redacting real values back into tokens before the container sees them.

import { describe, it, expect } from "vitest";
import { once } from "events";
import type { Transform } from "stream";
import type * as http from "http";
import {
  substituteHeaderValue,
  decodeChunked,
  hostMatches,
  reverseTokenMap,
  createRedactTransform,
  buildResponseHead,
} from "./credentialProxy";

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

  it("is case-insensitive on the scoped domain too", () => {
    expect(hostMatches("api.openai.com", "API.OpenAI.com")).toBe(true);
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

// Drive a transform with a fixed chunk sequence and return the concatenated output.
async function runTransform(t: Transform, chunks: string[]): Promise<string> {
  const out: Buffer[] = [];
  t.on("data", (c: Buffer) => out.push(c));
  for (const c of chunks) t.write(Buffer.from(c, "latin1"));
  t.end();
  await once(t, "end");
  return Buffer.concat(out).toString("latin1");
}

describe("createRedactTransform (response redaction)", () => {
  const redactMap = reverseTokenMap(tokenMap); // REAL → TOKEN

  it("redacts a value contained in a single chunk", async () => {
    const out = await runTransform(createRedactTransform(redactMap), [`Invalid API key: ${REAL}.`]);
    expect(out).toBe(`Invalid API key: ${TOKEN}.`);
  });

  it("redacts a value split across a chunk boundary (the carry case)", async () => {
    const split = 5; // mid-value
    const out = await runTransform(createRedactTransform(redactMap), [
      `prefix ${REAL.slice(0, split)}`,
      `${REAL.slice(split)} suffix`,
    ]);
    expect(out).toBe(`prefix ${TOKEN} suffix`);
    expect(out).not.toContain(REAL);
  });

  it("redacts multiple distinct values, including one ending exactly at stream end", async () => {
    const map = new Map([
      ["sk-first-value", "__pxy_ws1_A__"],
      ["sk-second-val", "__pxy_ws1_B__"],
    ]);
    const out = await runTransform(createRedactTransform(map), ["a sk-first-value b ", "sk-second-val"]);
    expect(out).toBe("a __pxy_ws1_A__ b __pxy_ws1_B__");
  });

  it("passes non-matching binary data through byte-identically", async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("latin1");
    const out = await runTransform(createRedactTransform(redactMap), [bytes, bytes]);
    expect(out).toBe(bytes + bytes);
  });

  it("flushes a final chunk shorter than the holdback window", async () => {
    const out = await runTransform(createRedactTransform(redactMap), ["ok"]);
    expect(out).toBe("ok");
  });
});

describe("reverseTokenMap", () => {
  it("inverts token→value into value→token", () => {
    expect(reverseTokenMap(tokenMap).get(REAL)).toBe(TOKEN);
  });

  it("drops empty values (would match everywhere)", () => {
    expect(reverseTokenMap(new Map([["__pxy_t__", ""]])).size).toBe(0);
  });
});

describe("buildResponseHead redaction", () => {
  const fakeRes = (headers: http.IncomingHttpHeaders): http.IncomingMessage =>
    ({ statusCode: 401, statusMessage: "Unauthorized", headers }) as unknown as http.IncomingMessage;

  it("redacts a real value echoed in a response header", () => {
    const head = buildResponseHead(fakeRes({ "x-echo": `Bearer ${REAL}` }), reverseTokenMap(tokenMap));
    expect(head).toContain(`x-echo: Bearer ${TOKEN}`);
    expect(head).not.toContain(REAL);
  });

  it("drops content-length when redacting (body length may change)", () => {
    const head = buildResponseHead(fakeRes({ "content-length": "42" }), reverseTokenMap(tokenMap));
    expect(head.toLowerCase()).not.toContain("content-length");
  });

  it("keeps content-length when no redaction map is given (plain-HTTP path)", () => {
    const head = buildResponseHead(fakeRes({ "content-length": "42" }));
    expect(head).toContain("content-length: 42");
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
