import { defineConfig } from "vitest/config";

// Root core tests only. Native host tests live under hosts/<id>/ and run through
// `npm run test:integration`; keeping them out of this discovery means the Node 22
// portable lane never needs native host dependencies, and a stale built
// hosts/*/dist/*.test.js duplicate can never be picked up here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
