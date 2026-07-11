// ssrfGuard.test.ts proves assertPublicUrl rejects private/internal addresses in isolation. This
// file proves the http_get tool actually WIRES that guard: the tool must run the SSRF check and
// bail BEFORE issuing any network request when the URL points at an internal address, and it must
// dial only the IP the guard validated (the anti-rebinding pin). The bug class is a tool that
// forgets the guard (or moves the request above it) — the guard can be perfect and the agent still
// reach 169.254.169.254. So the assertion is twofold: a blocked URL (a) surfaces an error and (b)
// never reaches the requester, while a legitimate public URL does reach it with the pinned IP.
//
// The guard itself is NOT mocked — that would defeat the point. We use real assertPublicUrl with
// literal IPs (which short-circuit before DNS, keeping the test network-free) and inject a fake
// requester as the network sink, exactly as pathGuard.test.ts uses a real normalizeRelpath and a
// fake exec runner.

import { describe, it, expect, vi } from "vitest";
import { WebFetchTool, type GuardedResponse, type Requester } from "./webFetch";

// protected _call invoked directly — we are testing the guard wiring, not zod/invoke wrapping.
type Callable = { _call(input: unknown): Promise<string> };
const callOf = (t: unknown) => (t as unknown as Callable)._call.bind(t);

const okResponse = (body = "ok", contentType = "text/plain"): GuardedResponse => ({
  status: 200,
  statusText: "OK",
  contentType,
  location: null,
  body,
});

// Literal private/internal addresses the guard must block. All are IP literals so assertPublicUrl
// short-circuits before DNS — no network, fully deterministic.
const BLOCKED = [
  "https://127.0.0.1/",          // loopback
  "https://169.254.169.254/",    // cloud metadata
  "https://10.0.0.1/",           // RFC1918
  "https://[::1]/",              // IPv6 loopback
];

describe("http_get wires the SSRF guard", () => {
  const makeTool = (requester: Requester) => ({
    requester: vi.fn(requester),
    call(input: { url: string }) {
      return callOf(new WebFetchTool(this.requester))(input);
    },
  });

  for (const url of BLOCKED) {
    it(`blocks "${url}" without touching the network`, async () => {
      const t = makeTool(async () => okResponse());
      const result = await t.call({ url });
      expect(result).toMatch(/error/i);
      expect(t.requester).not.toHaveBeenCalled();
    });
  }

  it("reaches the network for a legitimate public URL, pinned to the validated IP", async () => {
    // Public IP literal — guard returns without DNS, so the requester is reached.
    const t = makeTool(async () => okResponse());
    await t.call({ url: "https://1.1.1.1/" });
    expect(t.requester).toHaveBeenCalledTimes(1);
    // The requester is called with (url, pinnedIp, signal). For an IP-literal URL the pin IS the
    // literal — this is the anti-rebinding guarantee crossing the tool boundary.
    expect(t.requester.mock.calls[0]?.[0]).toBe("https://1.1.1.1/");
    expect(t.requester.mock.calls[0]?.[1]).toBe("1.1.1.1");
  });

  // The redirect bypass: a public host that 3xx-redirects to an internal address. Auto-follow would
  // open the private target unchecked; manual follow must re-guard the Location and refuse it. We
  // never request the internal host, and the call surfaces the block as an error.
  it("re-guards redirects and refuses one pointing at an internal address", async () => {
    const t = makeTool(async (target: string) => {
      if (target === "https://1.1.1.1/")
        return { status: 302, statusText: "Found", contentType: "", location: "https://169.254.169.254/latest/meta-data", body: "" };
      return okResponse("SECRET");
    });

    const result = await t.call({ url: "https://1.1.1.1/" });

    expect(result).toMatch(/error/i);
    expect(result).not.toContain("SECRET");
    // The internal redirect target was never requested.
    expect(t.requester.mock.calls.map((c) => c[0])).not.toContain("https://169.254.169.254/latest/meta-data");
  });

  it("follows a redirect to another public address and returns its body", async () => {
    const t = makeTool(async (target: string) => {
      if (target === "https://1.1.1.1/")
        return { status: 302, statusText: "Found", contentType: "", location: "https://8.8.8.8/page", body: "" };
      return okResponse("hello");
    });

    const result = await t.call({ url: "https://1.1.1.1/" });

    expect(result).toContain("hello");
    expect(result).toContain("https://8.8.8.8/page"); // final URL reported
    // The follow-up hop was pinned to the redirect target's IP literal.
    expect(t.requester.mock.calls[1]?.[1]).toBe("8.8.8.8");
  });
});
