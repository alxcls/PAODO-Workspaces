// Next.js configuration. Disables the dev toolbar indicator.
// WebSocket co-hosting is handled by the custom server (server.ts) — no additional config needed here.
import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["better-sqlite3", "pino"],
  logging: {
    incomingRequests: false,
  },
  // Turbopack is the default build engine in Next.js 16. Empty config tells Next.js
  // the webpack callback below is intentional and not a mistake. Turbopack handles
  // ESM natively so no conditionNames equivalent is needed.
  turbopack: {},
  webpack: (config, { webpack }) => {
    // Prevent workspace data files from triggering HMR rebuilds — WatchIgnorePlugin
    // avoids touching watchOptions.ignored (which has a strict schema in Next.js's webpack).
    config.plugins.push(new webpack.WatchIgnorePlugin({ paths: [path.resolve(__dirname, "data")] }));
    return config;
  },
};

export default nextConfig;
