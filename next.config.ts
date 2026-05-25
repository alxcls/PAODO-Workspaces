// Next.js configuration. Disables the dev toolbar indicator.
// WebSocket co-hosting is handled by the custom server (server.ts) — no additional config needed here.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["jsoncrack-react", "reaflow", "reablocks", "reakeys"],
  serverExternalPackages: ["pino", "pino-pretty"],
  logging: {
    incomingRequests: false,
  },
  webpack: (config) => {
    // jsoncrack-react ships ESM-only ("import" condition); webpack defaults don't include it
    config.resolve.conditionNames = ["import", ...(config.resolve.conditionNames ?? [])];
    return config;
  },
};

export default nextConfig;
