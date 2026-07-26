// http_get runs its fetch INSIDE the workspace container, through the credential proxy. That
// placement is the security property — not an implementation detail — so these tests pin the
// invariants that make it hold, rather than re-testing curl:
//
//   - the URL is passed as its OWN argv element (never interpolated into a shell string), so a
//     hostile URL cannot become a command;
//   - --noproxy is NEVER passed. HTTP_PROXY is env-var convention, not iptables: the moment this
//     tool opts out of the proxy it also opts out of destinationGuard's SSRF checks and audit
//     logging, which is the whole reason the old app-side ssrfGuard.ts could be retired;
//   - http:// is upgraded to https://, and non-http(s) schemes are refused before any exec — the
//     proxy only substitutes secrets over HTTPS, and cleartext must stay off the table;
//   - redirects are curl's job (-L, capped), because each hop then transits the guarded proxy —
//     but they stay pinned to https (--proto-redir), since normalizeUrl never sees a Location.
//
// The runner is faked (canned stdout/stderr/exit code) so no container or socket is involved.

import { describe, it, expect, vi } from "vitest";
import { WebFetchTool, buildCurlArgs } from "./webFetch";
import type { ExecRunner, ExecResult } from "../interfaces";

// protected _call invoked directly — we are testing transport + parsing, not zod/invoke wrapping.
type Callable = { _call(input: unknown): Promise<string> };
const callOf = (t: unknown) => (t as unknown as Callable)._call.bind(t);

// curl's -w writes the three metadata fields to stderr (%{stderr}); stdout is the raw body.
const meta = (status: number, contentType = "text/plain", finalUrl = "https://example.com/") =>
  `${status}\t${contentType}\t${finalUrl}`;

function makeRunner(result: Partial<ExecResult>) {
  const exec = vi.fn(async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: meta(200), ...result }));
  return { exec } as ExecRunner & { exec: ReturnType<typeof vi.fn> };
}

const call = (runner: ExecRunner, input: { url: string; prompt?: string }) => callOf(new WebFetchTool(runner))(input);

describe("http_get argv construction", () => {
  it("passes the URL as its own argv element, never interpolated into a shell string", () => {
    // A URL carrying shell metacharacters must ride as one opaque argv entry. If it were ever
    // folded into a `sh -c` string this assertion is what breaks.
    const hostile = "https://example.com/?x=$(id)&y=`whoami`;rm -rf /";
    const args = buildCurlArgs(hostile);
    expect(args[args.length - 1]).toBe(hostile);
    expect(args[0]).toBe("curl");
    expect(args.some((a) => a.includes("sh") && a.includes("-c"))).toBe(false);
  });

  it("never passes --noproxy, so traffic stays on the guarded credential-proxy path", () => {
    const args = buildCurlArgs("https://example.com/");
    expect(args).not.toContain("--noproxy");
    expect(args.join(" ")).not.toContain("noproxy");
  });

  it("bounds redirects, time and response size", () => {
    const args = buildCurlArgs("https://example.com/");
    expect(args).toContain("-L");
    expect(args[args.indexOf("--max-redirs") + 1]).toBe("5");
    // --max-time is also the hang guard: ExecRunner.exec() cannot be aborted from the app side.
    expect(args[args.indexOf("--max-time") + 1]).toBe("15");
    expect(args[args.indexOf("--max-filesize") + 1]).toBe(String(8 * 1024 * 1024));
  });

  it("holds redirect hops to https, so -L cannot follow a 302 into cleartext", () => {
    // normalizeUrl validates the entry URL only. Without these, a hostile (or merely sloppy) site
    // could redirect the fetch onto plain HTTP and take the request off TLS mid-chain.
    const args = buildCurlArgs("https://example.com/");
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(args[args.indexOf("--proto-redir") + 1]).toBe("=https");
  });
});

describe("http_get scheme handling", () => {
  it("upgrades http to https before fetching", async () => {
    const runner = makeRunner({ stdout: "body" });
    await call(runner, { url: "http://example.com/page" });
    expect(runner.exec.mock.calls[0]?.[0]).toContain("https://example.com/page");
  });

  it("upgrades an uppercase HTTP:// scheme rather than refusing it", async () => {
    // URL lowercases the protocol, so a case-sensitive prefix test would drop this into the
    // "only HTTPS" refusal — contradicting the tool description the model is bound against.
    const runner = makeRunner({ stdout: "body" });
    await call(runner, { url: "HTTP://example.com/page" });
    expect(runner.exec.mock.calls[0]?.[0]).toContain("https://example.com/page");
  });

  for (const url of ["ftp://example.com", "file:///etc/passwd"]) {
    it(`refuses "${url}" without executing anything`, async () => {
      const runner = makeRunner({});
      const result = await call(runner, { url });
      expect(result).toMatch(/error/i);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  }

  it("refuses a malformed URL without executing anything", async () => {
    const runner = makeRunner({});
    const result = await call(runner, { url: "not a url" });
    expect(result).toMatch(/error/i);
    expect(runner.exec).not.toHaveBeenCalled();
  });
});

describe("http_get response handling", () => {
  it("returns the body and the final (post-redirect) URL", async () => {
    const runner = makeRunner({ stdout: "hello world", stderr: meta(200, "text/plain", "https://example.com/final") });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toContain("hello world");
    expect(result).toContain("https://example.com/final");
  });

  it("includes the prompt when one is given", async () => {
    const runner = makeRunner({ stdout: "data" });
    const result = await call(runner, { url: "https://example.com/", prompt: "find the price" });
    expect(result).toContain("find the price");
    expect(result).toContain("data");
  });

  it("strips tags from html responses", async () => {
    const runner = makeRunner({
      stdout: "<html><script>evil()</script><p>Real content</p></html>",
      stderr: meta(200, "text/html; charset=utf-8"),
    });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toContain("Real content");
    expect(result).not.toContain("evil()");
    expect(result).not.toContain("<p>");
  });

  it("truncates an oversized body", async () => {
    const runner = makeRunner({ stdout: "x".repeat(25_000) });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toContain("content truncated");
    expect(result.length).toBeLessThan(21_000);
  });

  it("surfaces a non-2xx status as an error instead of returning the body", async () => {
    const runner = makeRunner({ stdout: "Not Found page", stderr: meta(404, "text/html") });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toMatch(/error/i);
    expect(result).toContain("404");
    expect(result).not.toContain("Not Found page");
  });

  it("surfaces a curl failure using its stderr message", async () => {
    // The proxy refusing a blocked destination reaches us as a non-zero curl exit.
    const runner = makeRunner({ code: 7, stdout: "", stderr: "curl: (7) Failed to connect" });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toMatch(/error/i);
    expect(result).toContain("Failed to connect");
  });

  it("keeps curl's -w block out of the error message when a failure emits both", async () => {
    // curl still writes -w on failure (as `000\t\t`). The diagnostic and the metadata share stderr,
    // so the reported error must not carry that trailing metadata line as if it were the message.
    const runner = makeRunner({ code: 7, stdout: "", stderr: "curl: (7) Failed to connect\n000\t\t" });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toContain("Failed to connect");
    expect(result).not.toContain("000");
  });

  it("reads the -w block even when curl also logged a diagnostic before it", async () => {
    const runner = makeRunner({ stdout: "body", stderr: `warning: something\n${meta(200)}` });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toContain("body");
    expect(result).not.toMatch(/error/i);
  });

  it("errors rather than guessing when the status metadata is unreadable", async () => {
    const runner = makeRunner({ stdout: "body", stderr: "" });
    const result = await call(runner, { url: "https://example.com/" });
    expect(result).toMatch(/error/i);
  });
});
