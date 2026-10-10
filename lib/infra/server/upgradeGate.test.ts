// An accepted /ws socket is a readable channel into a live agent session, so the failure that
// matters is a handshake accepted from the wrong page or without a credential.
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogThrottle } from "../logThrottle";
import { AuthFailureTracker } from "../security/httpAuth";
import { basicAuthenticator } from "../security/uiAuth";
import { createUpgradeGate, type UpgradeGateDependencies } from "./upgradeGate";

const UI = basicAuthenticator({ user: "admin", pass: "hunter2" });
const GOOD = "Basic " + Buffer.from("admin:hunter2").toString("base64");
const BAD = "Basic " + Buffer.from("admin:wrong").toString("base64");
const HEAD = Buffer.alloc(0);

function setup(overrides: Partial<UpgradeGateDependencies> = {}) {
  const audit = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const accept = vi.fn();
  const gate = createUpgradeGate({
    uiAuth: UI,
    allowedHosts: new Set(["app.test", "api.test"]),
    allowedOrigins: new Set(["app.test"]),
    apiHost: "api.test",
    authFailures: new AuthFailureTracker(),
    verifySessionCookie: (cookie: string) => cookie === "session=valid",
    accept,
    audit,
    ...overrides,
  } as unknown as UpgradeGateDependencies);

  const send = (request: { url?: string; headers?: Record<string, string> }) => {
    const req = {
      method: "GET",
      url: request.url ?? "/ws?workspaceId=w1",
      headers: { host: "app.test", origin: "https://app.test", ...request.headers },
      socket: { remoteAddress: "203.0.113.7" },
    };
    const socket = { write: vi.fn(), destroy: vi.fn() };
    gate(req as unknown as IncomingMessage, socket as unknown as Duplex, HEAD);
    const written = socket.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    return { socket, written };
  };
  return { send, accept, audit };
}

beforeEach(() => resetLogThrottle());

describe("upgrade gate — what gets through", () => {
  it("accepts a handshake carrying a valid UI credential", () => {
    const { send, accept } = setup();
    const { socket } = send({ headers: { authorization: GOOD } });

    expect(accept).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("accepts a handshake carrying only a valid session cookie", () => {
    const { send, accept } = setup();
    send({ headers: { cookie: "session=valid" } });

    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("leaves upgrades on other paths alone", () => {
    const { send, accept } = setup();
    const { socket } = send({ url: "/_next/webpack-hmr" });

    expect(accept).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});

describe("upgrade gate — refusals", () => {
  it("refuses an untrusted host with 421", () => {
    const { send, accept } = setup();
    const { socket, written } = send({ headers: { host: "evil.test", authorization: GOOD } });

    expect(written).toBe("HTTP/1.1 421 Misdirected Request\r\n\r\n");
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses another site's page with 403 even when it carries a valid credential", () => {
    const { send, accept } = setup();
    const { written } = send({ headers: { origin: "https://evil.test", authorization: GOOD } });

    expect(written).toBe("HTTP/1.1 403 Forbidden\r\n\r\n");
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a handshake with no Origin header", () => {
    const { send, accept } = setup();
    const { written } = send({ headers: { origin: "", authorization: GOOD } });

    expect(written).toBe("HTTP/1.1 403 Forbidden\r\n\r\n");
    expect(accept).not.toHaveBeenCalled();
  });

  it("checks the origin before the credential, so a foreign page cannot lock the user out", () => {
    const authFailures = new AuthFailureTracker(1);
    const { send } = setup({ authFailures });
    send({ headers: { origin: "https://evil.test", authorization: BAD } });

    expect(authFailures.isBlocked("203.0.113.7")).toBe(false);
  });

  // A challenge on a handshake made Safari open a credential dialog it could never satisfy.
  it("refuses a handshake with no credential with 401 and no challenge header", () => {
    const { send, accept, audit } = setup();
    const { socket, written } = send({});

    expect(written).toBe("HTTP/1.1 401 Unauthorized\r\n\r\n");
    expect(written).not.toMatch(/www-authenticate/i);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    expect(audit.warn.mock.calls[0][0]).toMatchObject({ event: "auth_challenge", transport: "websocket" });
  });

  it("refuses a wrong password with 401 and no challenge header", () => {
    const { send, accept, audit } = setup();
    const { written } = send({ headers: { authorization: BAD } });

    expect(written).toBe("HTTP/1.1 401 Unauthorized\r\n\r\n");
    expect(accept).not.toHaveBeenCalled();
    expect(audit.warn.mock.calls[0][0]).toMatchObject({ event: "auth_unauthorized", ip: "203.0.113.7" });
  });

  it("refuses a session cookie when the mode accepts none", () => {
    const { send, accept } = setup({ verifySessionCookie: () => false });
    send({ headers: { cookie: "session=valid" } });

    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a session cookie on the API host", () => {
    const { send, accept } = setup({ allowedOrigins: new Set(["app.test", "api.test"]) });
    send({ headers: { host: "api.test", origin: "https://api.test", cookie: "session=valid" } });

    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a locked-out address with 429", () => {
    const authFailures = new AuthFailureTracker(1);
    authFailures.recordFailure("203.0.113.7");
    const { send, accept } = setup({ authFailures });
    const { written } = send({ headers: { authorization: GOOD } });

    expect(written).toBe("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
    expect(accept).not.toHaveBeenCalled();
  });
});
