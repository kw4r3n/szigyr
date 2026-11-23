import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
// Cap workers so child cc/clang/z3/browser processes do not starve Vitest's 60s RPC timeout.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))),
  },
});
