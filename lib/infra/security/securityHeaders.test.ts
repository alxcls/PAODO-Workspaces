// The CSP is the app's main browser boundary. These tests pin its restrictive defaults and the
// prod-only HSTS / dev-only unsafe-eval toggles.
import { describe, it, expect } from "vitest";
import { buildSecurityHeaders } from "./securityHeaders";

describe("buildSecurityHeaders", () => {
  it("always sets the static hardening headers", () => {
    const h = buildSecurityHeaders({ isProduction: true });
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
  });

  it("uses self-only source restrictions", () => {
    const h = buildSecurityHeaders({ isProduction: true });
    expect(h["Content-Security-Policy"]).toContain("default-src 'self';");
    expect(h["Content-Security-Policy"]).not.toContain("://");
  });

  it("adds HSTS only in production", () => {
    expect(buildSecurityHeaders({ isProduction: true })["Strict-Transport-Security"]).toBeDefined();
    expect(buildSecurityHeaders({ isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("permits unsafe-eval only in dev (Next.js HMR)", () => {
    expect(buildSecurityHeaders({ isProduction: false })["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(buildSecurityHeaders({ isProduction: true })["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });

  it("disallows framing and scopes document base URLs", () => {
    const csp = buildSecurityHeaders({ isProduction: true })["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
