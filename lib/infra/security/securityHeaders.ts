// Builds the security response headers (CSP, HSTS, frame/sniff guards) for the custom HTTP server.
// Pure and header-store-agnostic — returns a name→value map that server.ts applies to the response.

export type SecurityHeaderOptions = {
  isProduction: boolean;
};

export function buildSecurityHeaders(opts: SecurityHeaderOptions): Record<string, string> {
  const { isProduction } = opts;
  const self = "'self'";

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
