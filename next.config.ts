// Next.js configuration. Disables the dev toolbar indicator.
// WebSocket co-hosting is handled by the custom server (server.ts) — no additional config needed here.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["better-sqlite3", "pino"],
  logging: {
    incomingRequests: false,
  },
};

export default nextConfig;
