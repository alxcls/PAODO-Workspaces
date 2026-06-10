import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Integration tests need real Docker — they run in their own tier
    // (vitest.integration.config.ts) so `npm test` stays fast and portable.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
