// The gate fronts every HTTP request. The dangerous failures are a request reaching Next.js that
// should have been refused, and a refusal that leaves no usable trace or prompts the wrong client.
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogThrottle } from "../logThrottle";
import { AuthFailureTracker } from "../security/httpAuth";
import { basicAuthenticator, type UiAuthenticator } from "../security/uiAuth";
import { createRequestGate, type RequestGateDependencies } from "./requestGate";

const UI = basicAuthenticator({ user: "admin", pass: "hunter2" });
const GOOD = "Basic " + Buffer.from("admin:hunter2").toString("base64");
const BAD = "Basic " + Buffer.from("admin:wrong").toString("base64");
const PLATFORM = "Bearer platform-secret";
const RATE_OK = { ok: true, retryAfter: 0, limit: 100, remaining: 99, policy: "global" as const };

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }
  end(body = "") {
    this.body = body;
    this.emit("finish");
  }
}

function setup(overrides: Partial<RequestGateDependencies> = {}) {
  const log = fakeLogger();
  const audit = fakeLogger();
  const handle = vi.fn();
  const deps = {
    uiAuth: UI,
    allowedHosts: new Set(["app.test", "api.test"]),
    apiHost: "api.test",
    authFailures: new AuthFailureTracker(),
    validatePlatformToken: (plain: string) => plain === "platform-secret",
    checkRateLimit: vi.fn(() => RATE_OK),
    hardenedBrowser: false,
    handle,
    log,
    audit,
    ...overrides,
  } as unknown as RequestGateDependencies;
  const gate = createRequestGate(deps);

  const send = (request: { method?: string; url?: string; headers?: Record<string, string> }) => {
    const req = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: { host: "app.test", ...request.headers } as Record<string, string>,
      socket: { remoteAddress: "203.0.113.7" },
    };
    const res = new FakeResponse();
    gate(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { req, res };
  };
  return { send, handle, log, audit, deps };
}

beforeEach(() => resetLogThrottle());

describe("request gate — what gets through", () => {
  it("hands a request with a valid UI credential to the handler", () => {
    const { send, handle } = setup();
    const { req, res } = send({ headers: { authorization: GOOD } });

    expect(handle).toHaveBeenCalledTimes(1);
    expect(res.headers["x-request-id"]).toBe(req.headers["x-request-id"]);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("mints the /ws session cookie for a verified UI credential in basic mode", () => {
    const { send } = setup();
    expect(send({ headers: { authorization: GOOD } }).res.headers["set-cookie"]).toMatch(/^paodo_ws_session=/);
  });

  it("never mints a session cookie for a platform token", () => {
    const { send, handle } = setup();
    const { res } = send({ url: "/api/workspace-graph", headers: { authorization: PLATFORM } });

    expect(handle).toHaveBeenCalledTimes(1);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("answers a valid platform token on an unshared route with 403, naming the method and path", () => {
    const { send, handle } = setup();
    const { res } = send({ method: "POST", url: "/api/usage", headers: { authorization: PLATFORM } });

    expect(handle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({ code: "FORBIDDEN", error: "This token cannot call POST /api/usage." });
  });

  it("never mints a session cookie outside basic mode", () => {
    const iap: UiAuthenticator = { ...UI, mode: "iap", challenge: null, verify: () => "ok" };
    const { send, handle } = setup({ uiAuth: iap });
    const { res } = send({});

    expect(handle).toHaveBeenCalledTimes(1);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("logs that auth works once, not per request", () => {
    const { send, audit } = setup();
    send({ headers: { authorization: GOOD } });
    send({ headers: { authorization: GOOD } });

    const authOk = audit.info.mock.calls.filter(([fields]) => fields.event === "auth_ok");
    expect(authOk).toHaveLength(1);
  });

  it("writes one access line when the response finishes", () => {
    const { send, log } = setup();
    const { res } = send({ url: "/dashboard", headers: { authorization: GOOD } });
    res.end();
    res.emit("close");

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatchObject({ event: "http_request", method: "GET", pathname: "/dashboard" });
  });
});

describe("request gate — refusals", () => {
  it("refuses an untrusted host with 421", () => {
    const { send, handle } = setup();
    const { res } = send({ headers: { host: "evil.test", authorization: GOOD } });

    expect(res.statusCode).toBe(421);
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses a rate-limited API call with 429 and the limit headers", () => {
    const limited = { ok: false, retryAfter: 12, limit: 30, remaining: 0, policy: "controlWrite" as const };
    const { send, handle } = setup({ checkRateLimit: vi.fn(() => limited) });
    const { res } = send({ url: "/api/workspaces", headers: { authorization: GOOD } });

    expect(res.statusCode).toBe(429);
    expect(res.headers).toMatchObject({ "retry-after": "12", "ratelimit-limit": "30", "ratelimit-remaining": "0" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not charge page requests to the API rate limit", () => {
    const checkRateLimit = vi.fn(() => RATE_OK);
    const { send } = setup({ checkRateLimit });
    send({ url: "/dashboard", headers: { authorization: GOOD } });

    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses a locked-out address with 429 even when the credential is right", () => {
    const authFailures = new AuthFailureTracker(1);
    authFailures.recordFailure("203.0.113.7");
    const { send, handle } = setup({ authFailures });
    const { res } = send({ headers: { authorization: GOOD } });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(handle).not.toHaveBeenCalled();
  });

  it("challenges a browser page that offers no credential", () => {
    const { send, handle, audit } = setup();
    const { res } = send({ url: "/dashboard" });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="App"');
    expect(res.body).toBe("Unauthorized");
    expect(handle).not.toHaveBeenCalled();
    // The normal first request of every session, so it is not an audit warning.
    expect(audit.warn).not.toHaveBeenCalled();
  });

  it("sends no challenge header in a mode that has none", () => {
    const iap: UiAuthenticator = { ...UI, mode: "iap", challenge: null, verify: () => "absent" };
    const { send } = setup({ uiAuth: iap });
    const { res } = send({});

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("refuses a wrong password with the UI challenge", () => {
    const { send, handle } = setup();
    const { res } = send({ headers: { authorization: BAD } });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="App"');
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers a refused Bearer token with a Bearer challenge", () => {
    const { send } = setup();
    const { res } = send({ url: "/api/workspace-graph", headers: { authorization: "Bearer nope" } });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="PAODO"');
  });

  it("refuses the UI password on the API host without advertising it", () => {
    const { send, handle } = setup();
    const { res } = send({ url: "/api/workspaces", headers: { host: "api.test", authorization: GOOD } });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses a cross-site mutation with 403 even when authenticated", () => {
    const { send, handle } = setup();
    const { res } = send({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: GOOD, "sec-fetch-site": "cross-site" },
    });

    expect(res.statusCode).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers API paths with the public JSON envelope and pages with plain text", () => {
    const { send } = setup();
    const api = send({ url: "/api/workspaces", headers: { host: "evil.test" } }).res;
    const page = send({ url: "/dashboard", headers: { host: "evil.test" } }).res;

    expect(api.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(api.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(api.body)).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
      error: "Misdirected Request",
      requestId: api.headers["x-request-id"],
    });
    expect(page.body).toBe("Misdirected Request");
  });
});

describe("request gate — order of checks", () => {
  it("checks the host before the rate limit and the credential", () => {
    const checkRateLimit = vi.fn(() => RATE_OK);
    const authFailures = new AuthFailureTracker();
    const { send } = setup({ checkRateLimit, authFailures });
    const { res } = send({ url: "/api/workspaces", headers: { host: "evil.test", authorization: BAD } });

    expect(res.statusCode).toBe(421);
    expect(checkRateLimit).not.toHaveBeenCalled();
    // A guess sent to the wrong host never reaches the tracker, so it cannot lock anyone out.
    for (let i = 0; i < 10; i++) send({ headers: { host: "evil.test", authorization: BAD } });
    expect(authFailures.isBlocked("203.0.113.7")).toBe(false);
  });

  it("checks the rate limit before the credential", () => {
    const limited = { ok: false, retryAfter: 1, limit: 1, remaining: 0, policy: "global" as const };
    const { send } = setup({ checkRateLimit: vi.fn(() => limited) });

    expect(send({ url: "/api/workspaces" }).res.statusCode).toBe(429);
  });

  it("checks the credential before CSRF", () => {
    const { send } = setup();
    const { res } = send({ method: "POST", url: "/api/workspaces", headers: { "sec-fetch-site": "cross-site" } });

    expect(res.statusCode).toBe(401);
  });
});

describe("request gate — audit trail", () => {
  const limited = { ok: false, retryAfter: 1, limit: 1, remaining: 0, policy: "global" as const };
  const lockedOut = () => {
    const tracker = new AuthFailureTracker(1);
    tracker.recordFailure("203.0.113.7");
    return tracker;
  };
  const rejections: Array<[string, Partial<RequestGateDependencies>, Parameters<ReturnType<typeof setup>["send"]>[0]]> =
    [
      ["request_host_rejected", {}, { url: "/api/workspaces", headers: { host: "evil.test" } }],
      ["api_rate_limited", { checkRateLimit: vi.fn(() => limited) }, { url: "/api/workspaces" }],
      ["auth_blocked", { authFailures: lockedOut() }, { url: "/api/workspaces" }],
      ["auth_unauthorized", {}, { url: "/api/workspaces", headers: { authorization: BAD } }],
      ["auth_forbidden", {}, { method: "PUT", url: "/api/workspaces", headers: { authorization: PLATFORM } }],
      [
        "csrf_blocked",
        {},
        { method: "POST", url: "/api/workspaces", headers: { authorization: GOOD, "sec-fetch-site": "cross-site" } },
      ],
    ];

  // The access line is suppressed for an audited request, so the audit record is the only place a
  // denied request's route is written down: auth_unauthorized once read {ip, requestId} only.
  it.each(rejections)("%s names the route, the client and the request", (event, overrides, request) => {
    const { send, audit, log } = setup(overrides);
    const { res } = send(request);
    res.emit("close");

    expect(audit.warn).toHaveBeenCalledTimes(1);
    expect(audit.warn.mock.calls[0][0]).toMatchObject({
      event,
      ip: "203.0.113.7",
      method: request.method ?? "GET",
      pathname: "/api/workspaces",
      requestId: res.headers["x-request-id"],
    });
    for (const level of [log.info, log.warn, log.error]) expect(level).not.toHaveBeenCalled();
  });

  it("writes one line for a flood of identical rejections", () => {
    const { send, audit } = setup();
    for (let i = 0; i < 20; i++) send({ headers: { host: "evil.test" } });

    expect(audit.warn).toHaveBeenCalledTimes(1);
  });
});
