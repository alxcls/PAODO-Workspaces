// End-to-end check of the proxy's request-forwarding path (not just the pure substitution helpers).
// Exercised over the plain-HTTP proxy path, which shares forwardRequestBody with the HTTPS MITM path
// but needs no TLS/CA harness. Focus: an `Expect: 100-continue` client must get an interim 100 and
// still have its body delivered upstream — previously it would hang forever.

import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import * as http from "http";
import { once } from "events";
import { CredentialProxy } from "./credentialProxy";

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

    client.write(
      `GET http://127.0.0.1:6379/ HTTP/1.1\r\nHost: 127.0.0.1:6379\r\n\r\n`,
    );
    const received = await readUntil(client, (s) => s.includes("\r\n"));
    expect(received).toContain("403");
    expect(received).not.toContain("200");
  });

  it("refuses a CONNECT tunnel to a loopback address with 403 and never sends 200", async () => {
    const proxyPort = await startProxy();

    const client = net.connect(proxyPort, "127.0.0.1");
    cleanups.push(() => client.destroy());
    await once(client, "connect");

    client.write(`CONNECT 127.0.0.1:6379 HTTP/1.1\r\nHost: 127.0.0.1:6379\r\n\r\n`);
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

    client.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n\r\n`);
    const received = await readUntil(client, (s) => s.includes("HELLO"));
    expect(received).toContain("200 Connection Established");
    expect(received).toContain("HELLO");
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
      `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`,
    );
    const received = await readUntil(good, (s) => s.includes("200"));
    expect(received).toContain("200");
  });
});
