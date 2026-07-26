// End-to-end check of the proxy's request-forwarding path (not just the pure substitution helpers).
// Exercised over the plain-HTTP proxy path, which shares forwardRequestBody with the HTTPS MITM path
// but needs no TLS/CA harness. Focus: an `Expect: 100-continue` client must get an interim 100 and
// still have its body delivered upstream — previously it would hang forever.

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import * as net from "net";
import * as http from "http";
import * as https from "https";
import * as tls from "tls";
import { once } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import forge from "node-forge";

// credentialProxy.ts now reads the internet-access policy store, which persists to a file under
// WORKSPACES_ROOT — redirect it to a throwaway temp dir before that import chain runs, so this
// suite's setInternetAccessPolicy calls below never touch the real ./data. Mirrors apiKeyStore.test.ts.
vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  process.env.WORKSPACES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "credproxy-server-test-"));
});

import { CredentialProxy } from "./credentialProxy";
import { ensureCA, deriveProxySecret } from "./proxyCA";
import { setInternetAccessPolicy } from "./internetAccessPolicy";

// The proxy now requires a verified workspace identity on every connection (not just for
// domain-scoped injection), so every test below needs the HMAC key that backs verifyProxySecret —
// set it up once, up front, before any describe block's tests run.
beforeAll(() => {
  ensureCA(mkdtempSync(path.join(tmpdir(), "proxy-server-test-ca-")));
});

// Shared across every describe below — a valid `Proxy-Authorization` header for `wsId`.
function authHeader(wsId: string): string {
  return `Proxy-Authorization: Basic ${Buffer.from(`${wsId}:${deriveProxySecret(wsId)}`).toString("base64")}\r\n`;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function listeningPort(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

// Start a stub upstream that records the last request method/path/body it received.
async function startUpstream(): Promise<{ port: number; received: Promise<{ body: string }> }> {
  let resolve!: (v: { body: string }) => void;
  const received = new Promise<{ body: string }>((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      resolve({ body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  cleanups.push(() => server.close());
  const port = await listeningPort(server);
  return { port, received };
}

async function startProxy(opts?: { blockDestination?: (ip: string) => boolean }): Promise<number> {
  const proxy = new CredentialProxy(opts);
  const server = (proxy as unknown as { server: net.Server }).server;
  proxy.listen(0);
  await once(server, "listening");
  cleanups.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

// Allow everything, so forwarding tests can reach a loopback stub upstream. Production uses the
// real IP-class guard (isBlockedAddress) that these SSRF tests exercise via the default proxy.
const allowAll = { blockDestination: () => false };

// Read from a socket until `predicate(accumulated)` is true or the socket closes; return the text.
function readUntil(sock: net.Socket, predicate: (s: string) => boolean): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => resolve(buf);
    sock.on("data", (c) => {
      buf += c.toString();
      if (predicate(buf)) done();
    });
    sock.on("close", done);
    sock.on("end", done);
  });
}

describe("CredentialProxy Expect: 100-continue", () => {
  it("sends an interim 100 Continue and forwards the withheld body upstream", async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(allowAll);

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    let sawContinue = false;
    let bodySent = false;
    const body = "grant_type=client_credentials";
    let received = "";
    let resolveResponse!: () => void;
    const gotResponse = new Promise<void>((r) => (resolveResponse = r));
    client.on("data", (chunk) => {
      received += chunk.toString();
      // Only send the body once the proxy has told us to proceed — the whole point of the header.
      if (!bodySent && received.includes("100 Continue")) {
        sawContinue = true;
        bodySent = true;
        client.write(body);
      }
      if (received.includes("200")) resolveResponse();
    });

    const head =
      `POST http://127.0.0.1:${upstream.port}/token HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${upstream.port}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `Expect: 100-continue\r\n` +
      authHeader("ws-100continue") +
      `\r\n`;
    client.write(head);

    const got = await upstream.received;
    await gotResponse;
    expect(sawContinue).toBe(true);
    expect(got.body).toBe(body);
    expect(received).toContain("200");
  });
});

describe("CredentialProxy SSRF guard", () => {
  it("refuses a plain-HTTP forward to a loopback address with 403", async () => {
    const proxyPort = await startProxy(); // default = real IP-class guard

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`GET http://127.0.0.1:6379/ HTTP/1.1\r\nHost: 127.0.0.1:6379\r\n${authHeader("ws-ssrf-http")}\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
    expect(received).not.toContain("200");
  });

  it("refuses a CONNECT tunnel to a loopback address with 403 and never sends 200", async () => {
    const proxyPort = await startProxy();

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:6379 HTTP/1.1\r\nHost: 127.0.0.1:6379\r\n${authHeader("ws-ssrf-connect")}\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
    expect(received).not.toContain("Connection Established");
  });

  it("still establishes a CONNECT tunnel to an allowed destination", async () => {
    // Stub TCP upstream that greets the moment a connection lands.
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    const proxyPort = await startProxy(allowAll);
    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(
      `CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n${authHeader("ws-ssrf-allowed")}\r\n`,
    );
    const received = await readUntil(client, (s) => s.includes("HELLO"));
    expect(received).toContain("200 Connection Established");
    expect(received).toContain("HELLO");
  });
});

// The internet-access policy check runs immediately after auth resolution, ahead of both the CONNECT
// and plain-HTTP paths, and ahead of any domain-rule logic — a workspace can be refused here even
// when it has a configured secret rule for the exact host it's trying to reach. This is the
// application-layer backstop behind the real boundary (the workspace's Docker network being
// --internal, containerManager.ts) — these tests only cover this layer in isolation.
describe("CredentialProxy internet-access policy", () => {
  const WS = "ws-net-off";

  beforeAll(() => {
    ensureCA(mkdtempSync(path.join(tmpdir(), "proxy-netpolicy-test-")));
  });

  it("refuses a CONNECT tunnel with a 403 when the workspace is off, even to an allowed destination", async () => {
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    setInternetAccessPolicy(WS, false);
    const proxyPort = await startProxy(allowAll);
    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n${authHeader(WS)}\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
    expect(received).not.toContain("Connection Established");
    expect(received).not.toContain("HELLO");
  });

  it("refuses a plain-HTTP forward with a 403 when the workspace is off", async () => {
    const upstream = await startUpstream();
    setInternetAccessPolicy(WS, false);
    const proxyPort = await startProxy(allowAll);

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(
      `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n${authHeader(WS)}\r\n`,
    );
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
    expect(received).not.toContain("200");
  });

  it("still refuses even when a domain rule is configured for the exact host requested", async () => {
    // Proves ordering: the off-check runs ahead of, not instead of, domain-scoped secret injection.
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    setInternetAccessPolicy(WS, false);
    const proxy = new CredentialProxy(allowAll);
    proxy.setRules(WS, [{ domain: "127.0.0.1", tokenMap: new Map([["__pxy_t__", "real"]]) }]);
    const server = (proxy as unknown as { server: net.Server }).server;
    proxy.listen(0);
    await once(server, "listening");
    cleanups.push(() => server.close());
    const proxyPort = (server.address() as net.AddressInfo).port;

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n${authHeader(WS)}\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
  });

  it("re-enabling the workspace restores the tunnel", async () => {
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    setInternetAccessPolicy(WS, false);
    setInternetAccessPolicy(WS, true);
    const proxyPort = await startProxy(allowAll);

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n${authHeader(WS)}\r\n`);
    const received = await readUntil(client, (s) => s.includes("HELLO"));
    expect(received).toContain("200 Connection Established");
  });

  it("refuses an unauthenticated connection outright (no Proxy-Authorization header)", async () => {
    // Was the actual bypass: an absent header used to skip the off-check entirely (it's keyed on
    // auth.wsId, and auth is null with no header) and still get a plain tunnel through. Now any
    // connection without a verified identity is refused before the off-check is even reached.
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    const proxyPort = await startProxy(allowAll);

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("407");
    expect(received).not.toContain("Connection Established");
    expect(received).not.toContain("HELLO");
  });

  it("refuses a connection that claims another workspace's id with a wrong/guessed secret (spoofed identity)", async () => {
    // The other half of the bypass: isInternetAccessEnabled defaults to true for any id never
    // toggled off, so claiming an unrelated (or made-up) wsId used to sail past the off-check even
    // though the secret was never verified. Now the identity itself must verify before anything else
    // runs, so a wrong secret is refused regardless of whose id it claims.
    const stub = net.createServer((sock) => sock.write("HELLO"));
    cleanups.push(() => stub.close());
    const stubPort = await listeningPort(stub);

    const proxyPort = await startProxy(allowAll);
    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    const forged = `Proxy-Authorization: Basic ${Buffer.from("some-other-workspace:not-the-real-secret").toString("base64")}\r\n`;
    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n${forged}\r\n`);
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("407");
    expect(received).not.toContain("Connection Established");
    expect(received).not.toContain("HELLO");
  });
});

// Full MITM loop: CONNECT with valid proxy auth → TLS terminated by the proxy → token substituted
// into the upstream request → upstream response REDACTED (real value → token) before the client
// sees it. This is the leak-resistance core: even an upstream that echoes the credential back
// (API error messages) must never expose plaintext to the container.
describe("CredentialProxy MITM response redaction", () => {
  const WS = "ws-mitm";
  const TOKEN = "__pxy_ws-mitm_API_KEY__";
  const REAL = "sk-real-value-9876543210abcdef";

  let stubKey: string;
  let stubCert: string;

  beforeAll(() => {
    // deriveProxySecret/verifyProxySecret and the MITM's signDomainCert need an initialized CA.
    ensureCA(mkdtempSync(path.join(tmpdir(), "proxy-mitm-test-")));

    // Self-signed cert with an IP SAN for the loopback HTTPS stub. signDomainCert only emits DNS
    // SANs, and the proxy re-originates with rejectUnauthorized:true — Node requires an IP SAN to
    // verify a cert for "127.0.0.1", so the stub brings its own chain, injected via upstreamCa.
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
    const attrs = [{ name: "commonName", value: "127.0.0.1" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    stubCert = forge.pki.certificateToPem(cert);
    stubKey = forge.pki.privateKeyToPem(keys.privateKey);
  }, 30_000);

  async function startMitmProxy(): Promise<{ port: number; proxy: CredentialProxy }> {
    const proxy = new CredentialProxy({ blockDestination: () => false, upstreamCa: stubCert });
    proxy.setRules(WS, [{ domain: "127.0.0.1", tokenMap: new Map([[TOKEN, REAL]]) }]);
    const server = (proxy as unknown as { server: net.Server }).server;
    proxy.listen(0);
    await once(server, "listening");
    cleanups.push(() => server.close());
    return { port: (server.address() as net.AddressInfo).port, proxy };
  }

  async function startHttpsStub(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<number> {
    const server = https.createServer({ key: stubKey, cert: stubCert }, handler);
    cleanups.push(() => server.close());
    return await listeningPort(server);
  }

  // CONNECT through the proxy with valid workspace auth, TLS-handshake against the MITM cert,
  // send one GET carrying the token, and return the full plaintext response the client saw.
  async function requestThroughMitm(proxyPort: number, stubPort: number): Promise<string> {
    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    const proxyAuth = Buffer.from(`${WS}:${deriveProxySecret(WS)}`).toString("base64");
    client.write(
      `CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${stubPort}\r\n` +
        `Proxy-Authorization: Basic ${proxyAuth}\r\n\r\n`,
    );
    await readUntil(client, (s) => s.includes("200 Connection Established"));

    // The proxy terminates TLS with its on-the-fly cert; the chain isn't what's under test here
    // (production trust wiring is covered by the container CA-bundle setup), so skip verification.
    const tlsSock = tls.connect({ socket: client, rejectUnauthorized: false });
    cleanups.push(() => tlsSock.destroy());
    await once(tlsSock, "secureConnect");

    tlsSock.write(
      `GET /echo HTTP/1.1\r\n` + `Host: 127.0.0.1:${stubPort}\r\n` + `Authorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    // Response is connection-close delimited — read until the socket ends.
    return await readUntil(tlsSock, () => false);
  }

  it("injects the real value upstream but redacts it from the echoed response (header + body)", async () => {
    let upstreamAuth = "";
    const stubPort = await startHttpsStub((req, res) => {
      upstreamAuth = req.headers.authorization ?? "";
      // Echo the credential back in both places an API typically leaks it.
      res.writeHead(401, { "content-type": "text/plain", "x-echo": upstreamAuth });
      res.end(`Invalid API key provided: ${REAL}. Check your credentials.`);
    });
    const { port: proxyPort } = await startMitmProxy();

    const response = await requestThroughMitm(proxyPort, stubPort);

    // Upstream received the REAL credential (injection worked end-to-end)…
    expect(upstreamAuth).toBe(`Bearer ${REAL}`);
    // …but the client-visible bytes never contain it — header and body are both redacted.
    expect(response).not.toContain(REAL);
    expect(response).toContain(`x-echo: Bearer ${TOKEN}`);
    expect(response).toContain(`Invalid API key provided: ${TOKEN}.`);
  });

  it("redacts a value split across two streamed response writes", async () => {
    const stubPort = await startHttpsStub((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write(`stream ${REAL.slice(0, 9)}`); // cut mid-value
      setTimeout(() => {
        res.write(`${REAL.slice(9)} end`);
        res.end();
      }, 25);
    });
    const { port: proxyPort } = await startMitmProxy();

    const response = await requestThroughMitm(proxyPort, stubPort);

    expect(response).not.toContain(REAL);
    expect(response).toContain(`stream ${TOKEN} end`);
  });
});

describe("CredentialProxy header cap", () => {
  it("tears down a connection whose headers exceed the cap without hanging", async () => {
    const proxyPort = await startProxy();

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    let received = "";
    client.on("data", (c) => (received += c.toString()));

    // Send an oversized header line (>64 KB) with no terminating CRLFCRLF.
    client.write(`GET http://example.com/ HTTP/1.1\r\nX-Big: ${"A".repeat(70 * 1024)}`);

    // The proxy caps the header read, rejects, and closes the connection — it must not hang
    // waiting for a terminator. Reaching the close/end event proves the teardown happened.
    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      client.on("end", () => resolve());
    });
    expect(received).not.toContain("200");
  });

  it("still serves a normal request after an oversized one (process stays responsive)", async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy(allowAll);

    // First connection: oversized headers → torn down.
    const bad = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => bad.destroy());
    await once(bad, "connect");
    bad.write(`GET http://example.com/ HTTP/1.1\r\nX-Big: ${"A".repeat(70 * 1024)}`);
    await new Promise<void>((r) => bad.on("close", () => r()));

    // Second connection on the same proxy: a normal GET is still forwarded.
    const good = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => good.destroy());
    await once(good, "connect");
    good.write(
      `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n${authHeader("ws-headercap")}\r\n`,
    );
    const received = await readUntil(good, (s) => s.includes("200"));
    expect(received).toContain("200");
  });
});
