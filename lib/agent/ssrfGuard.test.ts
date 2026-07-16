// Tests for the SSRF network guard (ssrfGuard.ts).
import { describe, it, expect } from "vitest";
import { isPrivateIP, assertPublicUrl, type HostnameResolver } from "./ssrfGuard";

// The network counterpart to the path-containment guard: the agent must never
// reach an internal/private address via http_get. These tests assert BEHAVIOR
// (input -> allowed-or-blocked), so they survive any reimplementation of the
// guard's internals. A resolver that always returns a private IP can never be
// reached from the public path of these tests by accident — we inject it.

// A resolver must never be consulted for IP literals; if it is, the test fails
// loudly rather than silently passing on the wrong code path.
const failingResolver: HostnameResolver = async () => {
  throw new Error("resolver should not be called for IP literals");
};

describe("isPrivateIP — address classifier", () => {
  it("flags loopback, RFC1918, link-local and CGNAT IPv4", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("10.0.0.5")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
    expect(isPrivateIP("169.254.169.254")).toBe(true); // cloud metadata endpoint
    expect(isPrivateIP("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });

  it("allows ordinary public IPv4", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("172.32.0.1")).toBe(false); // just outside the 172.16/12 block
    expect(isPrivateIP("100.63.0.1")).toBe(false); // just outside CGNAT
  });

  it("flags loopback, ULA, link-local and mapped IPv6", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("::")).toBe(true);
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd12:3456::1")).toBe(true);
    expect(isPrivateIP("fe80::1")).toBe(true);
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows ordinary public IPv6", () => {
    expect(isPrivateIP("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
  });

  it("treats anything that is not a parseable IP literal as unsafe", () => {
    expect(isPrivateIP("not-an-ip")).toBe(true);
    expect(isPrivateIP("")).toBe(true);
  });
});

describe("assertPublicUrl — http_get chokepoint", () => {
  it("allows a public HTTPS URL and returns it with the validated IP", async () => {
    const pub: HostnameResolver = async () => ({ address: "8.8.8.8" });
    await expect(assertPublicUrl("https://example.com/path", pub)).resolves.toEqual({
      url: "https://example.com/path",
      ip: "8.8.8.8",
    });
  });

  it("upgrades http to https", async () => {
    const pub: HostnameResolver = async () => ({ address: "8.8.8.8" });
    await expect(assertPublicUrl("http://example.com", pub)).resolves.toEqual({
      url: "https://example.com",
      ip: "8.8.8.8",
    });
  });

  it("pins the exact resolved IP so the caller cannot be rebound to another address", async () => {
    // The anti-rebinding guarantee: whatever the resolver returned is handed back verbatim for the
    // caller to dial. If this drifts from the address that was validated, the window reopens.
    const pub: HostnameResolver = async () => ({ address: "93.184.216.34" });
    const { ip } = await assertPublicUrl("https://example.com", pub);
    expect(ip).toBe("93.184.216.34");
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("ftp://example.com", failingResolver)).rejects.toThrow("Only HTTPS URLs are allowed");
    await expect(assertPublicUrl("file:///etc/passwd", failingResolver)).rejects.toThrow("Only HTTPS URLs are allowed");
  });

  it("rejects malformed URLs", async () => {
    await expect(assertPublicUrl("not a url", failingResolver)).rejects.toThrow("Invalid URL");
  });

  it("blocks private IPv4 literals without consulting DNS", async () => {
    await expect(assertPublicUrl("https://127.0.0.1", failingResolver)).rejects.toThrow("Blocked internal address");
    await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data", failingResolver)).rejects.toThrow(
      "Blocked internal address",
    );
  });

  it("blocks bracketed private IPv6 literals", async () => {
    await expect(assertPublicUrl("https://[::1]/", failingResolver)).rejects.toThrow("Blocked internal address");
  });

  it("allows public IP literals without consulting DNS and pins the literal", async () => {
    await expect(assertPublicUrl("https://8.8.8.8", failingResolver)).resolves.toEqual({
      url: "https://8.8.8.8",
      ip: "8.8.8.8",
    });
  });

  it("blocks a hostname that resolves to a private IP", async () => {
    // The dangerous case: a public-looking name pointing at internal infra.
    const evil: HostnameResolver = async () => ({ address: "10.0.0.5" });
    await expect(assertPublicUrl("https://internal.evil.test", evil)).rejects.toThrow("Blocked internal address");
  });

  it("allows a hostname that resolves to a public IP", async () => {
    const good: HostnameResolver = async () => ({ address: "93.184.216.34" });
    await expect(assertPublicUrl("https://example.com", good)).resolves.toEqual({
      url: "https://example.com",
      ip: "93.184.216.34",
    });
  });

  it("rejects when the hostname cannot be resolved", async () => {
    const broken: HostnameResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicUrl("https://does-not-exist.test", broken)).rejects.toThrow("Failed to resolve hostname");
  });
});
