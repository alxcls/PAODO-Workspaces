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

async function startProxy(): Promise<number> {
  const proxy = new CredentialProxy();
  const server = (proxy as unknown as { server: net.Server }).server;
  proxy.listen(0);
  await once(server, "listening");
  cleanups.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

describe("CredentialProxy Expect: 100-continue", () => {
  it("sends an interim 100 Continue and forwards the withheld body upstream", async () => {
    const upstream = await startUpstream();
    const proxyPort = await startProxy();

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
