// HTTP/1.1 wire-protocol mechanics for the credential proxy — parsing a request/response head off a
// raw socket, decoding a body (Content-Length or chunked), and forwarding it upstream. This module
// knows nothing about secrets or token substitution: it moves bytes and frames them correctly. The
// substitution/redaction policy lives in credentialProxy.ts, which drives these helpers. Splitting
// the two apart keeps each independently testable and lets protocol-correctness changes stay clear
// of secret-handling changes.
import * as net from "net";
import * as http from "http";

// Max request body we buffer in order to substitute inside it. API calls that carry a secret in the
// body (OAuth token exchange, GraphQL, form posts) are small; larger bodies are binary uploads that
// don't contain secret tokens, so the caller streams those through untouched rather than buffer them.
export const MAX_BODY_SUBSTITUTE = 10 * 1024 * 1024;

const HEADER_SEP = Buffer.from("\r\n\r\n");

// Cap on the request head (status line + headers) we will buffer before finding the terminating
// CRLFCRLF. The proxy is a single shared process, so an unbounded read lets one container OOM every
// workspace. Mirrors MAX_BODY_SUBSTITUTE, which already bounds the body path.
const MAX_HEADER_BYTES = 64 * 1024;

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
export function bodyMode(headers: Record<string, string>): "buffer" | "stream" | "none" {
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
export function collectBody(src: net.Socket, headers: Record<string, string>, remaining: Buffer): Promise<Buffer> {
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

export async function readHttpHeaders(readable: NodeJS.ReadableStream): Promise<{
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
export function pipeBody(
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
