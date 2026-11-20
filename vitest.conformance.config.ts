import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/compiler/test/conformance.conf.ts"], testTimeout: 30_000 } });
