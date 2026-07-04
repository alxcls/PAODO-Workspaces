// Transparent credential proxy for workspace secrets.
// Containers connect to this proxy via HTTP_PROXY/HTTPS_PROXY. Their shell env vars hold opaque
// proxy tokens (e.g. __pxy_wsId_OPENAI_API_KEY__) instead of real secret values.
// For HTTPS to configured domains: MITM the TLS, substitute tokens with real values in every place
// a secret can travel in an HTTP request — the request target (path + query string), all header
// values (including base64-wrapped `Authorization: Basic`), and the request body — then forward to
// upstream. For all other HTTPS: plain TCP tunnel (no interception).
// Injection is HTTPS-only: plain HTTP is cleartext on the wire, so we never substitute a real value
// there (it would leak the secret to any on-path observer). HTTP requests are forwarded untouched,
// carrying only the opaque token, which upstream rejects — failing closed instead of leaking.
// The one thing substitution fundamentally cannot cover is auth where the secret is consumed by a
// computation before transmission (AWS SigV4 / HMAC request signing, SCRAM DB auth): there is no
// literal token on the wire to replace. Those secrets must be present in the container.
// Domain allowlist prevents relay attacks: real values are only injected for the user-configured domain.
// Responses on the MITM path are REDACTED in reverse (real value → token) so an upstream that
// echoes the credential back (API error messages are the common case) never exposes plaintext to
// the container. This covers the literal value only — an upstream that base64s or otherwise
// transforms the secret before echoing is not caught; accidental-echo protection, not a guarantee.
import * as net from "net";
import * as tls from "tls";
import * as http from "http";
import * as https from "https";
import { Transform } from "stream";
import { signDomainCert, verifyProxySecret } from "./proxyCA";
import { isBlockedAddress, makeGuardedLookup } from "./destinationGuard";
import { createLogger } from "../logger";
import type { DomainRule } from "../security/workspaceSecretStore";

const log = createLogger("credentialProxy");

// token → real value
type TokenMap = Map<string, string>;

// Parse the workspace id (username) and secret (password) out of a Proxy-Authorization header.
// The container's proxy URL carries both as `http://<wsId>:<secret>@host…`.
function parseProxyAuth(authHeader: string | undefined): { wsId: string; secret: string } | null {
  if (!authHeader?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { wsId: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

// A request to `hostname` is covered by a rule only when they are the exact same host. Subdomains
// are intentionally NOT matched: a key scoped to "api.openai.com" must never be injected into some
// other "*.openai.com" host an attacker might influence.
export function hostMatches(hostname: string, domain: string): boolean {
  return hostname.toLowerCase() === domain;
}

// Merge the token maps of every rule whose domain covers this host. If none match, the
// returned map is empty — the caller then tunnels/forwards without touching the traffic.
function tokenMapForHost(rules: DomainRule[], hostname: string): TokenMap {
  const map: TokenMap = new Map();
  for (const rule of rules) {
    if (hostMatches(hostname, rule.domain)) {
      for (const [token, value] of rule.tokenMap) map.set(token, value);
    }
  }
  return map;
}

function substituteTokens(value: string, tokenMap: TokenMap): string {
  for (const [token, realValue] of tokenMap) {
    if (value.includes(token)) value = value.split(token).join(realValue);
  }
  return value;
}

// Substitute in a single header value. Covers the plain case (token appears verbatim) and
// `Authorization: Basic base64(user:token)`, where the client base64-encodes the credentials so
// the literal token never appears in the header — we decode, substitute, and re-encode.
export function substituteHeaderValue(value: string, tokenMap: Map<string, string>): string {
  const direct = substituteTokens(value, tokenMap);
  const basic = /^Basic\s+(\S+)\s*$/i.exec(direct);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("latin1");
      const replaced = substituteTokens(decoded, tokenMap);
      if (replaced !== decoded) return "Basic " + Buffer.from(replaced, "latin1").toString("base64");
    } catch {
      // not valid base64 — keep the direct substitution
    }
  }
  return direct;
}

// Invert a token map (token → real value) into a redaction map (real value → token) for the
// response direction. Empty-string values are dropped defensively (they would match everywhere).
export function reverseTokenMap(tokenMap: TokenMap): TokenMap {
  const rev: TokenMap = new Map();
  for (const [token, value] of tokenMap) {
    if (value.length > 0) rev.set(value, token);
  }
  return rev;
}

// Redact real secret values back into their opaque tokens in a byte stream WITHOUT buffering it —
// buffering whole responses would stall streaming APIs (SSE), which is exactly the traffic this
// proxy fronts. A carry of (longest value - 1) bytes is held back between chunks so a value split
// across a chunk boundary is still caught; the carry is flushed on stream end. Substitution runs
// over carry+chunk each time — re-substituting already-redacted text is a no-op because tokens
// never contain secret values. Latin1 keeps the transform byte-safe (same convention as the
// request-body substitution below).
export function createRedactTransform(redactMap: TokenMap): Transform {
  const maxLen = Math.max(1, ...[...redactMap.keys()].map((v) => v.length));
  const holdback = maxLen - 1;
  let carry = "";
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const s = substituteTokens(carry + chunk.toString("latin1"), redactMap);
      const emitEnd = Math.max(0, s.length - holdback);
      carry = s.slice(emitEnd);
      if (emitEnd > 0) this.push(Buffer.from(s.slice(0, emitEnd), "latin1"));
      cb();
    },
    flush(cb) {
      // A partial value at the very end can never complete — emit the carry (one more idempotent
      // substitution pass in case the final chunk completed a value exactly at the boundary).
      if (carry.length) this.push(Buffer.from(substituteTokens(carry, redactMap), "latin1"));
      cb();
    },
  });
}

// Substitute every request-line/header place a secret can ride: the request target (path + query
// string) and all header values. Mutates `headers` in place; returns the substituted path.
// The request body is handled separately by forwardRequestBody (it must be buffered to rewrite).
function substituteRequestMeta(
  requestPath: string,
  headers: Record<string, string>,
  tokenMap: TokenMap,
): string {
  for (const k of Object.keys(headers)) headers[k] = substituteHeaderValue(headers[k], tokenMap);
  return substituteTokens(requestPath, tokenMap);
}

// Max request body we buffer in order to substitute inside it. API calls that carry a secret in the
// body (OAuth token exchange, GraphQL, form posts) are small; larger bodies are binary uploads that
// don't contain secret tokens, so we stream those through untouched rather than buffer them.
const MAX_BODY_SUBSTITUTE = 10 * 1024 * 1024;

// Decode an HTTP/1.1 chunked request body as far as the bytes allow. `done` is true once the
// terminating zero-length chunk has been seen, meaning `body` is the complete decoded payload.
export function decodeChunked(raw: Buffer): { body: Buffer; done: boolean } {
  const out: Buffer[] = [];
  let pos = 0;
  let done = false;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos, "latin1");
    if (lineEnd === -1) break;
    const size = parseInt(raw.toString("latin1", pos, lineEnd).trim(), 16);
    if (Number.isNaN(size)) break;
    if (size === 0) { done = true; break; }
    const dataStart = lineEnd + 2;
    if (dataStart + size + 2 > raw.length) break; // rest of this chunk hasn't arrived yet
    out.push(raw.subarray(dataStart, dataStart + size));
    pos = dataStart + size + 2; // skip chunk data + trailing CRLF
  }
  return { body: Buffer.concat(out), done };
}

// How to forward the request body: "buffer" (small enough to read fully, substitute, and re-send
// with a corrected Content-Length), "stream" (too large — forward as-is), or "none" (no body).
function bodyMode(headers: Record<string, string>): "buffer" | "stream" | "none" {
  const clRaw = headers["content-length"];
  if (clRaw !== undefined) {
    const cl = parseInt(clRaw, 10);
    if (!Number.isFinite(cl) || cl <= 0) return "none";
    return cl <= MAX_BODY_SUBSTITUTE ? "buffer" : "stream";
  }
  if (/(^|,)\s*chunked\s*(,|$)/i.test(headers["transfer-encoding"] ?? "")) return "buffer";
  return "none";
}

// Read the full request body (Content-Length or chunked) so it can be substituted. The upstream
// socket was paused by readHttpHeaders, so we prepend the already-read `remaining` bytes and resume.
function collectBody(src: net.Socket, headers: Record<string, string>, remaining: Buffer): Promise<Buffer> {
  const clRaw = headers["content-length"];
  const contentLength = clRaw !== undefined ? parseInt(clRaw, 10) : -1;
  return new Promise((resolve, reject) => {
    let raw: Buffer = Buffer.from(remaining);
    const cleanup = () => {
      src.removeListener("data", onData);
      src.removeListener("error", onError);
      src.removeListener("end", onEnd);
      src.pause();
    };
    const settle = (): boolean => {
      if (contentLength >= 0) {
        if (raw.length < contentLength) return false;
        cleanup();
        resolve(raw.subarray(0, contentLength));
        return true;
      }
      const { body, done } = decodeChunked(raw);
      if (done) { cleanup(); resolve(body); return true; }
      if (raw.length > MAX_BODY_SUBSTITUTE) {
        cleanup();
        reject(new Error("chunked request body exceeds substitution cap"));
        return true;
      }
      return false;
    };
    const onData = (chunk: Buffer) => { raw = raw.length ? Buffer.concat([raw, chunk]) : chunk; settle(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onEnd = () => {
      cleanup();
      resolve(contentLength >= 0 ? raw.subarray(0, Math.max(0, contentLength)) : decodeChunked(raw).body);
    };
    src.on("data", onData);
    src.on("error", onError);
    src.on("end", onEnd);
    if (!settle()) src.resume();
  });
}

const HEADER_SEP = Buffer.from("\r\n\r\n");

// Cap on the request head (status line + headers) we will buffer before finding the terminating
// CRLFCRLF. The proxy is a single shared process, so an unbounded read lets one container OOM every
// workspace. Mirrors MAX_BODY_SUBSTITUTE, which already bounds the body path.
const MAX_HEADER_BYTES = 64 * 1024;

async function readHttpHeaders(readable: NodeJS.ReadableStream): Promise<{
  statusLine: string;
  headers: Record<string, string>;
  remaining: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;

    const onData = (chunk: Buffer) => {
      if (done) return;
      chunks.push(chunk);
      received += chunk.length;
      const all = Buffer.concat(chunks);
      const idx = all.indexOf(HEADER_SEP);
      if (idx === -1) {
        if (received > MAX_HEADER_BYTES) {
          done = true;
          (readable as NodeJS.EventEmitter).removeListener("data", onData);
          (readable as NodeJS.EventEmitter).removeListener("error", onError);
          reject(new Error("request headers exceed cap"));
        }
        return;
      }
      done = true;
      (readable as NodeJS.ReadableStream & { pause(): void; removeListener(e: string, fn: unknown): void }).pause();
      (readable as NodeJS.EventEmitter).removeListener("data", onData);
      (readable as NodeJS.EventEmitter).removeListener("error", onError);
      const headText = all.slice(0, idx).toString("latin1");
      const remaining = all.slice(idx + 4);
      const lines = headText.split("\r\n");
      const statusLine = lines[0];
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const sep = lines[i].indexOf(":");
        if (sep !== -1) {
          headers[lines[i].slice(0, sep).toLowerCase().trim()] = lines[i].slice(sep + 1).trim();
        }
      }
      resolve({ statusLine, headers, remaining });
    };

    const onError = (err: Error) => {
      if (done) return;
      done = true;
      (readable as NodeJS.EventEmitter).removeListener("data", onData);
      reject(err);
    };

    (readable as NodeJS.EventEmitter).on("data", onData);
    (readable as NodeJS.EventEmitter).on("error", onError);
    (readable as NodeJS.ReadableStream & { resume(): void }).resume();
  });
}

// Forward the request body to the upstream request and call end() at the right time.
// The root problem with waiting for socket "end": HTTP/1.1 clients keep the tunnel alive
// after sending headers, so "end" never fires for GET/HEAD. We use Content-Length instead:
// if bodyLength === 0 (or absent), end immediately; otherwise stream exactly bodyLength bytes.
function pipeBody(
  src: NodeJS.ReadableStream & NodeJS.EventEmitter & { resume(): void; removeListener(e: string, fn: unknown): void },
  dest: http.ClientRequest,
  headers: Record<string, string>,
  remaining: Buffer,
): void {
  const bodyLength = parseInt(headers["content-length"] ?? "0", 10);
  if (remaining.length) dest.write(remaining);

  if (bodyLength <= remaining.length) {
    dest.end();
    src.resume();
    return;
  }

  let sent = remaining.length;
  const onData = (chunk: Buffer) => {
    dest.write(chunk);
    sent += chunk.length;
    if (sent >= bodyLength) {
      src.removeListener("data", onData);
      dest.end();
    }
  };
  src.on("data", onData);
  src.resume();
}

export function buildResponseHead(res: http.IncomingMessage, redactMap?: TokenMap): string {
  const redact = (val: string): string => (redactMap ? substituteTokens(val, redactMap) : val);
  let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
  for (const [k, v] of Object.entries(res.headers)) {
    const key = k.toLowerCase();
    // Node's HTTP client already decoded chunked transfer-encoding into a plain
    // stream, so `res` yields de-chunked bytes. Forwarding the original
    // `transfer-encoding: chunked` header would make the client try to de-chunk an
    // already-decoded body (e.g. gzip magic \x1f\x8b) → InvalidChunkLength / hang.
    // We instead delimit the body by closing the connection (see below), so drop
    // both this and the upstream `connection` header.
    if (key === "transfer-encoding" || key === "connection") continue;
    // When redacting (MITM path), body redaction can change its length, and the body is
    // connection-close/EOF-delimited anyway — a stale content-length would truncate the client read.
    if (redactMap && key === "content-length") continue;
    if (Array.isArray(v)) {
      for (const val of v) head += `${k}: ${redact(val)}\r\n`;
    } else if (v !== undefined) {
      head += `${k}: ${redact(v)}\r\n`;
    }
  }
  // Body length is now unknown to us (chunked was stripped, no content-length added),
  // so the client must read until EOF. The pipe() calls end() the socket on upstream
  // end, delivering that EOF.
  head += "connection: close\r\n";
  return head + "\r\n";
}

export class CredentialProxy {
  private rules = new Map<string, DomainRule[]>();
  private server: net.Server;
  // Predicate deciding whether a resolved destination IP is off-limits (SSRF guard), plus a
  // hostname lookup built from it. Injectable so tests can point the proxy at a loopback stub.
  private blockDestination: (ip: string) => boolean;
  private lookup: net.LookupFunction;
  // Extra CA(s) trusted for the re-originated upstream TLS. Test-only injection (lets an e2e
  // test run an HTTPS stub with a self-signed chain); production always uses the system roots.
  private upstreamCa?: string | string[];

  constructor(opts?: { blockDestination?: (ip: string) => boolean; upstreamCa?: string | string[] }) {
    this.blockDestination = opts?.blockDestination ?? isBlockedAddress;
    this.upstreamCa = opts?.upstreamCa;
    this.lookup = makeGuardedLookup(this.blockDestination);
    this.server = net.createServer((socket) => {
      this.handleConnection(socket).catch((err) => {
        log.debug({ err: String(err) }, "proxy connection error");
        socket.destroy();
      });
    });
    this.server.on("error", (err) => log.error({ err }, "proxy server error"));
  }

  listen(port: number): void {
    this.server.listen(port, "0.0.0.0", () => {
      log.info({ port }, "credential proxy listening");
    });
  }

  setRules(wsId: string, rules: DomainRule[]): void {
    if (rules.length === 0) this.rules.delete(wsId);
    else this.rules.set(wsId, rules);
  }

  clearRules(wsId: string): void {
    this.rules.delete(wsId);
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    socket.on("error", () => socket.destroy());

    const { statusLine, headers, remaining } = await readHttpHeaders(socket);
    const auth = parseProxyAuth(headers["proxy-authorization"]);
    // Only apply a workspace's injection rules when the presented secret matches the one derived
    // from its id. A caller that knows another workspace's id but not its secret gets an empty rule
    // set — the connection still tunnels/forwards, but no real value is ever substituted (fail closed).
    const wsId = auth?.wsId ?? "";
    let rules: DomainRule[] = [];
    if (auth && verifyProxySecret(auth.wsId, auth.secret)) {
      rules = this.rules.get(auth.wsId) ?? [];
    } else if (this.rules.has(wsId)) {
      log.debug({ wsId }, "proxy secret mismatch — refusing credential injection");
    }

    if (statusLine.startsWith("CONNECT ")) {
      const target = statusLine.split(" ")[1] ?? "";
      const colonIdx = target.lastIndexOf(":");
      const hostname = colonIdx !== -1 ? target.slice(0, colonIdx) : target;
      const port = colonIdx !== -1 ? parseInt(target.slice(colonIdx + 1), 10) : 443;

      // Only intercept TLS for hosts a secret is scoped to. Every other host (pypi, apt
      // mirrors, github…) is a straight tunnel, so package installs and clones are untouched.
      const tokenMap = tokenMapForHost(rules, hostname);
      if (tokenMap.size > 0) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        await this.handleMitm(socket, hostname, port, tokenMap, remaining);
      } else {
        // SSRF guard: refuse tunnels to internal addresses. IP literals are checked here (net.connect
        // skips DNS for them, so guardedLookup would never see them); hostnames are validated by the
        // lookup, which rejects a resolved address in a blocked range. The 200 is withheld until the
        // upstream is actually established, so a blocked target only ever gets a 403.
        if (net.isIP(hostname) && this.blockDestination(hostname)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        const upstream = net.connect({ host: hostname, port, lookup: this.lookup });
        let established = false;
        upstream.on("error", () => {
          if (!established) { try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch { /* socket gone */ } }
          socket.destroy();
          upstream.destroy();
        });
        socket.on("error", () => { socket.destroy(); upstream.destroy(); });
        upstream.on("connect", () => {
          established = true;
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (remaining.length) upstream.write(remaining);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.resume();
        });
      }
    } else {
      await this.handleHttpProxy(socket, statusLine, headers, remaining);
    }
  }

  private async handleMitm(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    tokenMap: TokenMap,
    prefixData: Buffer,
  ): Promise<void> {
    const { cert: certPem, key: keyPem } = signDomainCert(hostname);

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: keyPem,
      cert: certPem,
    });
    tlsSocket.on("error", () => tlsSocket.destroy());
    tlsSocket.on("tlsClientError", (err) => {
      log.debug({ err: String(err), hostname }, "TLS client error in MITM");
      tlsSocket.destroy();
    });

    if (prefixData.length) clientSocket.unshift(prefixData);

    const { statusLine, headers, remaining } = await readHttpHeaders(tlsSocket);

    const parts = statusLine.split(" ");
    const method = parts[0] ?? "GET";

    delete headers["proxy-authorization"];
    // Force an identity-encoded response so the redaction below can scan it. Secret-domain API
    // traffic is small JSON — losing compression there is fine. (A non-compliant server that
    // compresses anyway passes through unredacted: accidental-echo coverage, not a guarantee.)
    delete headers["accept-encoding"];
    headers["connection"] = "close";
    const requestPath = substituteRequestMeta(parts[1] ?? "/", headers, tokenMap);

    // Response direction: redact real values back into tokens so an upstream echoing the
    // credential (error messages, request mirrors) never exposes plaintext to the container.
    const redactMap = reverseTokenMap(tokenMap);

    const startUpstream = () =>
      https.request(
        {
          hostname,
          port,
          method,
          path: requestPath,
          headers,
          rejectUnauthorized: true,
          ca: this.upstreamCa,
          lookup: this.lookup,
        },
        (upstreamRes) => {
          tlsSocket.write(buildResponseHead(upstreamRes, redactMap));
          upstreamRes.pipe(createRedactTransform(redactMap)).pipe(tlsSocket);
          upstreamRes.on("error", () => tlsSocket.destroy());
        },
      );

    await this.forwardRequestBody(tlsSocket, headers, remaining, tokenMap, startUpstream, hostname);
  }

  // Forward the request body upstream, substituting tokens inside it when it is small enough to
  // buffer. Shared by the MITM (HTTPS) and plain-HTTP paths — only the request factory differs.
  private async forwardRequestBody(
    src: net.Socket,
    headers: Record<string, string>,
    remaining: Buffer,
    tokenMap: TokenMap,
    startUpstream: () => http.ClientRequest,
    hostname: string,
  ): Promise<void> {
    // Honor `Expect: 100-continue`: the client withholds the body until it sees an interim 100
    // response (Python requests does this on larger POSTs — exactly the token-exchange calls this
    // proxy serves). We buffer and re-send the body ourselves, so tell the client to proceed and
    // drop the header before forwarding upstream (we don't relay the expectation onward).
    if (/(^|,)\s*100-continue\s*($|,)/i.test(headers["expect"] ?? "")) {
      src.write("HTTP/1.1 100 Continue\r\n\r\n");
      delete headers["expect"];
    }

    if (bodyMode(headers) === "buffer") {
      let raw: Buffer;
      try {
        raw = await collectBody(src, headers, remaining);
      } catch (err) {
        log.debug({ err: String(err), hostname }, "request body read failed");
        src.destroy();
        return;
      }
      const body = Buffer.from(substituteTokens(raw.toString("latin1"), tokenMap), "latin1");
      // Length changed (token → real value) and any chunked framing is gone: fix the headers.
      headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
      const req = startUpstream();
      req.on("error", (err) => {
        log.debug({ err: String(err), hostname }, "upstream request error");
        src.destroy();
      });
      req.end(body);
    } else {
      // No body, or too large to buffer — stream it through untouched (headers/path already done).
      const req = startUpstream();
      req.on("error", (err) => {
        log.debug({ err: String(err), hostname }, "upstream request error");
        src.destroy();
      });
      pipeBody(src, req, headers, remaining);
    }
  }

  private async handleHttpProxy(
    socket: net.Socket,
    statusLine: string,
    headers: Record<string, string>,
    remaining: Buffer,
  ): Promise<void> {
    // e.g. GET http://example.com/path HTTP/1.1
    const match = /^(\w+)\s+http:\/\/([^/\s]+)(\/[^\s]*)?\s/.exec(statusLine);
    if (!match) { socket.destroy(); return; }

    const [, method, hostHeader, requestPath = "/"] = match;
    const colonIdx = hostHeader.lastIndexOf(":");
    const hostname = colonIdx !== -1 ? hostHeader.slice(0, colonIdx) : hostHeader;
    const port = colonIdx !== -1 ? parseInt(hostHeader.slice(colonIdx + 1), 10) : 80;

    // SSRF guard: refuse plain-HTTP forwards to internal addresses. IP literals are checked here
    // (http.request skips DNS for them); hostnames are validated by this.lookup below.
    if (net.isIP(hostname) && this.blockDestination(hostname)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Secrets are injected over HTTPS only. Plain HTTP is cleartext on the wire, so substituting
    // a real value here would leak it to any on-path observer. We forward HTTP untouched (empty
    // token map = no substitution); the opaque token travels instead, which upstream rejects
    // rather than the credential leaking. `rules` is intentionally unused on this path.
    const tokenMap: TokenMap = new Map();

    delete headers["proxy-authorization"];
    headers["connection"] = "close";
    const path = substituteRequestMeta(requestPath, headers, tokenMap);

    const startUpstream = () =>
      http.request(
        { hostname, port, method, path, headers, lookup: this.lookup },
        (upstreamRes) => {
          socket.write(buildResponseHead(upstreamRes));
          upstreamRes.pipe(socket);
          upstreamRes.on("error", () => socket.destroy());
        },
      );

    await this.forwardRequestBody(socket, headers, remaining, tokenMap, startUpstream, hostname);
  }
}
