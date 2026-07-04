// Builds the security response headers (CSP, HSTS, frame/sniff guards) for the custom HTTP server.
// Pure and header-store-agnostic — returns a name→value map that server.ts applies to the response,
// so the CSP construction (including the opaque-origin reasoning below) is unit-testable.

export type SecurityHeaderOptions = {
  /** Raw x-forwarded-proto header value (may contain a comma-separated list), if present. */
  forwardedProto: string | undefined;
  /** Request Host header, used to name our own origin in the CSP alongside 'self'. */
  host: string | undefined;
  isProduction: boolean;
};

export function buildSecurityHeaders(opts: SecurityHeaderOptions): Record<string, string> {
  const { forwardedProto, host, isProduction } = opts;

  // The HTML-preview iframe runs at an OPAQUE origin (sandboxed, no allow-same-origin) and, being a
  // srcdoc document, INHERITS this page's CSP. Under an opaque origin `'self'` no longer matches our
  // own app origin, so the preview's app-origin subresources (images/styles/fonts/scripts/base href
  // via the serve route) and its token-gated proxy fetch would be blocked. Naming our own origin
  // explicitly alongside `'self'` fixes that — for any normal same-origin document it is equivalent
  // to `'self'`; it only additionally lets opaque-origin previews load OUR-origin resources (display-
  // only or token-gated), never any third-party origin.
  const proto = ((forwardedProto || "").split(",")[0].trim()) || (isProduction ? "https" : "http");
  const self = host ? `'self' ${proto}://${host}` : "'self'";

  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Content-Security-Policy": [
      `default-src ${self}`,
      `script-src ${self} 'unsafe-inline'${!isProduction ? " 'unsafe-eval'" : ""}`,
      `style-src ${self} 'unsafe-inline'`,
      `img-src ${self} data: blob:`,
      `font-src ${self}`,
      `connect-src ${self} ws: wss:`,
      `worker-src ${self} blob: data:`,
      "frame-src 'self'",
      "frame-ancestors 'none'",
      `form-action ${self}`,
      `base-uri ${self}`,
    ].join("; "),
  };

  if (isProduction) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }

  return headers;
}
