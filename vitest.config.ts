import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Integration tests need real Docker — they run in their own tier
    // (vitest.integration.config.ts) so `npm test` stays fast and portable.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    // Coverage is for VISIBILITY, not a gate (see adr-testing-strategy-invariants-and-primitives):
    // run `npm run test:coverage` to see which untested files are trivial glue vs. quietly
    // important. Deliberately no threshold — we test invariants, not lines.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // App source only; exclude config/build/dev tooling, type-only files, and test scaffolding
      // so the report reflects logic we could meaningfully test.
      include: ["app/**/*.ts", "lib/**/*.ts", "server.ts"],
      exclude: ["**/*.test.ts", "**/interfaces.ts", "**/*.d.ts"],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
});
