// buildStaticPreviewHtml wraps drive HTML for the scriptless preview: it must inject a locked-down
// CSP (no scripts / no network egress) and must NOT carry any of the workspace live-preview
// machinery (<base>, preview token, fetch-shim) that only makes sense for a container.
import { describe, it, expect } from "vitest";
import { buildStaticPreviewHtml } from "./HtmlStaticPreview";

describe("buildStaticPreviewHtml", () => {
  it("injects the CSP meta immediately after an existing <head>", () => {
    const out = buildStaticPreviewHtml("<html><head><title>R</title></head><body>x</body></html>");
    expect(out).toContain('<head><meta http-equiv="Content-Security-Policy"');
    // meta comes before the original head content, not after </head>
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
  });

  it("prepends the CSP meta when there is no <head>", () => {
    const out = buildStaticPreviewHtml("<body>just a fragment</body>");
    // the meta is the first thing in the output
    expect(out).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  });

  it("locks the CSP down to no scripts and no network egress", () => {
    const out = buildStaticPreviewHtml("<p>hi</p>");
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("img-src data:");
    expect(out).toContain("base-uri 'none'");
  });

  it("carries no live-preview machinery (base / token / fetch-shim)", () => {
    const out = buildStaticPreviewHtml("<head></head><script>fetch('/api')</script>");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("PREVIEW_TOKEN");
    expect(out).not.toContain("window.fetch");
  });
});
