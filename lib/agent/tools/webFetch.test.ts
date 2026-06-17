// ssrfGuard.test.ts proves assertPublicUrl rejects private/internal addresses in isolation. This
// file proves the http_get tool actually WIRES that guard: the tool must run the SSRF check and
// bail BEFORE issuing any network request when the URL points at an internal address. The bug
// class is a tool that forgets the guard (or moves the fetch above it) — the guard can be perfect
// and the agent still reach 169.254.169.254. So the assertion is twofold: a blocked URL (a)
// surfaces an error and (b) never reaches global fetch, while a legitimate public URL does reach it.
//
// The guard itself is NOT mocked — that would defeat the point. We use real assertPublicUrl with
// literal IPs (which short-circuit before DNS, keeping the test network-free) and mock only the
// fetch sink, exactly as pathGuard.test.ts uses a real normalizeRelpath and a fake exec runner.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebFetchTool } from "./webFetch";

// protected _call invoked directly — we are testing the guard wiring, not zod/invoke wrapping.
type Callable = { _call(input: unknown): Promise<string> };
const callOf = (t: unknown) => (t as unknown as Callable)._call.bind(t);

// Literal private/internal addresses the guard must block. All are IP literals so assertPublicUrl
// short-circuits before DNS — no network, fully deterministic.
const BLOCKED = [
  "https://127.0.0.1/",          // loopback
  "https://169.254.169.254/",    // cloud metadata
  "https://10.0.0.1/",           // RFC1918
  "https://[::1]/",              // IPv6 loopback
];

describe("http_get wires the SSRF guard", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let call: (input: { url: string }) => Promise<string>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("ok", { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    call = callOf(new WebFetchTool());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const url of BLOCKED) {
    it(`blocks "${url}" without touching the network`, async () => {
      const result = await call({ url });
      expect(result).toMatch(/error/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("reaches the network for a legitimate public URL", async () => {
    // Public IP literal — guard returns without DNS, so fetch is reached.
    await call({ url: "https://1.1.1.1/" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://1.1.1.1/");
    // Redirects must be followed manually (so the guard re-runs per hop), never auto-followed.
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  // The redirect bypass: a public host that 3xx-redirects to an internal address. Auto-follow would
  // open the private target unchecked; manual follow must re-guard the Location and refuse it. We
  // never fetch the internal host, and the call surfaces the block as an error.
  it("re-guards redirects and refuses one pointing at an internal address", async () => {
    fetchMock.mockImplementation(async (target: string) => {
      if (target === "https://1.1.1.1/")
        return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
      return new Response("SECRET", { headers: { "content-type": "text/plain" } });
    });

    const result = await call({ url: "https://1.1.1.1/" });

    expect(result).toMatch(/error/i);
    expect(result).not.toContain("SECRET");
    // The internal redirect target was never opened.
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("https://169.254.169.254/latest/meta-data");
  });

  it("follows a redirect to another public address and returns its body", async () => {
    fetchMock.mockImplementation(async (target: string) => {
      if (target === "https://1.1.1.1/")
        return new Response(null, { status: 302, headers: { location: "https://8.8.8.8/page" } });
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    });

    const result = await call({ url: "https://1.1.1.1/" });

    expect(result).toContain("hello");
    expect(result).toContain("https://8.8.8.8/page"); // final URL reported
  });
});
