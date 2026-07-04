// The CSP is the app's main defense against a hostile agent-built preview reaching third-party
// origins, so these tests pin the origin-naming logic (proto resolution + our-origin allowance)
// and the prod-only HSTS / dev-only unsafe-eval toggles.
import { describe, it, expect } from "vitest";
import { buildSecurityHeaders } from "./securityHeaders";

describe("buildSecurityHeaders", () => {
  it("always sets the static hardening headers", () => {
    const h = buildSecurityHeaders({ forwardedProto: undefined, host: "app.example", isProduction: true });
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });

  it("names our own origin alongside 'self' in the CSP so opaque-origin previews can load it", () => {
    const h = buildSecurityHeaders({ forwardedProto: "https", host: "app.example", isProduction: true });
    expect(h["Content-Security-Policy"]).toContain("default-src 'self' https://app.example");
  });

  it("falls back to 'self' alone when no Host header is present", () => {
    const h = buildSecurityHeaders({ forwardedProto: "https", host: undefined, isProduction: true });
    expect(h["Content-Security-Policy"]).toContain("default-src 'self';");
    expect(h["Content-Security-Policy"]).not.toContain("://");
  });

  it("uses the first x-forwarded-proto entry when a list is given", () => {
    const h = buildSecurityHeaders({ forwardedProto: "https, http", host: "app.example", isProduction: true });
    expect(h["Content-Security-Policy"]).toContain("https://app.example");
    expect(h["Content-Security-Policy"]).not.toContain("http://app.example");
  });

  it("defaults proto to https in production and http in dev when the header is absent", () => {
    const prod = buildSecurityHeaders({ forwardedProto: undefined, host: "app.example", isProduction: true });
    expect(prod["Content-Security-Policy"]).toContain("https://app.example");
    const dev = buildSecurityHeaders({ forwardedProto: undefined, host: "app.example", isProduction: false });
    expect(dev["Content-Security-Policy"]).toContain("http://app.example");
  });

  it("adds HSTS only in production", () => {
    expect(buildSecurityHeaders({ forwardedProto: "https", host: "h", isProduction: true })["Strict-Transport-Security"]).toBeDefined();
    expect(buildSecurityHeaders({ forwardedProto: "http", host: "h", isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("permits unsafe-eval only in dev (Next.js HMR)", () => {
    expect(buildSecurityHeaders({ forwardedProto: "http", host: "h", isProduction: false })["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(buildSecurityHeaders({ forwardedProto: "https", host: "h", isProduction: true })["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });

  it("keeps the preview iframe boxed in (frame-ancestors none, base-uri scoped)", () => {
    const csp = buildSecurityHeaders({ forwardedProto: "https", host: "h", isProduction: true })["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self' https://h");
  });
});
