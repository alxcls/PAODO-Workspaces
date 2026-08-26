import { defineConfig } from "vitest/config";
import path from "path";

// Integration tier: tests that need real external systems (Docker, etc.).
// Run with `npm run test:integration`. Kept separate from the unit suite so
// `npm test` needs no Docker and stays fast on any machine / CI stage.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 60_000, // docker run is slow
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
