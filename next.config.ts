// Next.js configuration. Disables the dev toolbar indicator.
// WebSocket co-hosting is handled by the custom server (server.ts) — no additional config needed here.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
};

export default nextConfig;
