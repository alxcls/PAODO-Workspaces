// Both gates on a real listener, called over real HTTP and WebSocket connections. The unit tests
// cover every case with fakes; this proves the gates behave the same once attached to a server.
import { createServer, request, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { resetLogThrottle } from "../logThrottle";
import { AuthFailureTracker } from "../security/httpAuth";
import { basicAuthenticator } from "../security/uiAuth";
import { verifySessionCookie } from "../security/wsSession";
import { createRequestGate } from "./requestGate";
import { createUpgradeGate } from "./upgradeGate";
import { createWorkspaceSocketHandler } from "./workspaceSocket";

const GOOD = "Basic " + Buffer.from("admin:hunter2").toString("base64");
const HOST = "app.test";
const ORIGIN = "https://app.test";

let server: Server;
let wss: WebSocketServer;
let port: number;
// Fresh per test, so one test's refused credentials cannot lock out the next.
let authFailures: AuthFailureTracker;

beforeAll(async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const uiAuth = basicAuthenticator({ user: "admin", pass: "hunter2" });
  const allowedHosts = new Set([HOST]);
  const tracker = {
    isBlocked: (ip: string) => authFailures.isBlocked(ip),
    recordFailure: (ip: string) => authFailures.recordFailure(ip),
    clear: (ip: string) => authFailures.clear(ip),
  } as unknown as AuthFailureTracker;

  wss = new WebSocketServer({ noServer: true });
  const open = new Set<unknown>();
  wss.on(
    "connection",
    createWorkspaceSocketHandler({
      getWorkspace: (id) => (id === "w1" ? { dir: "/data/w1" } : undefined),
      connections: {
        add: (_id, ws) => void open.add(ws),
        remove: (_id, ws) => void open.delete(ws),
        count: () => open.size,
      },
      loadConversations: () => [],
      watcher: { ensure: vi.fn(), stop: vi.fn(), markSelfWrite: vi.fn() },
      clearTodos: vi.fn(),
      log: logger as never,
      idleGraceMs: 0,
    }),
  );
  server = createServer();
  server.on(
    "request",
    createRequestGate({
      uiAuth,
      allowedHosts,
      apiHost: null,
      authFailures: tracker,
      validatePlatformToken: () => false,
      checkRateLimit: () => ({ ok: true, retryAfter: 0, limit: 100, remaining: 99, policy: "global" }),
      hardenedBrowser: false,
      handle: (_req, res) => res.end("reached the app"),
      log: logger as never,
      audit: logger as never,
    }),
  );
  server.on(
    "upgrade",
    createUpgradeGate({
      uiAuth,
      allowedHosts,
      allowedOrigins: allowedHosts,
      apiHost: null,
      authFailures: tracker,
      verifySessionCookie,
      accept: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)),
      audit: logger as never,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  resetLogThrottle();
  authFailures = new AuthFailureTracker();
});

// node:http rather than fetch, which refuses to send a caller-chosen Host header.
function call(options: { method?: string; path?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { host: HOST, ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Resolves with the open socket, or with the HTTP status the handshake was refused with. */
function connect(headers: Record<string, string>, workspaceId = "w1") {
  return new Promise<WebSocket | number>((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws?workspaceId=${workspaceId}`;
    const ws = new WebSocket(url, { headers: { host: HOST, ...headers } });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", reject);
  });
}

async function sessionCookie(): Promise<string> {
  const res = await call({ headers: { authorization: GOOD } });
  return String(res.headers["set-cookie"]?.[0]).split(";")[0];
}

describe("gates on a live server — HTTP", () => {
  it("lets a request with a valid credential reach the app", async () => {
    const res = await call({ headers: { authorization: GOOD } });

    expect(res.status).toBe(200);
    expect(res.body).toBe("reached the app");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("answers 401 with a challenge when no credential is sent", async () => {
    const res = await call({});

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="App"');
  });

  it("answers 421 for an untrusted host", async () => {
    expect((await call({ headers: { host: "evil.test", authorization: GOOD } })).status).toBe(421);
  });

  it("answers 403 with the JSON envelope for a cross-site POST", async () => {
    const res = await call({
      method: "POST",
      path: "/api/workspaces",
      headers: { authorization: GOOD, "sec-fetch-site": "cross-site" },
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("gates on a live server — WebSocket", () => {
  it("connects with the session cookie an authenticated request was given", async () => {
    const ws = await connect({ origin: ORIGIN, cookie: await sessionCookie() });
    expect(ws).toBeInstanceOf(WebSocket);

    const socket = ws as WebSocket;
    const reply = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await reply).toBe('{"type":"pong"}');
    socket.close();
  });

  it("closes an authenticated connection to an unknown workspace", async () => {
    const socket = (await connect({ origin: ORIGIN, cookie: await sessionCookie() }, "nope")) as WebSocket;
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    expect(await closed).toBe(1008);
  });

  it("refuses a valid session coming from another site's page", async () => {
    expect(await connect({ origin: "https://evil.test", cookie: await sessionCookie() })).toBe(403);
  });

  it("refuses a handshake with no credential", async () => {
    expect(await connect({ origin: ORIGIN })).toBe(401);
  });

  it("refuses a handshake for an untrusted host", async () => {
    expect(await connect({ host: "evil.test", origin: ORIGIN, cookie: await sessionCookie() })).toBe(421);
  });
});
