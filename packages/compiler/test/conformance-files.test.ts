import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadCases } from "./harness.ts";

it("real conformance/ headers parse and meet the stage-0 counts", () => {
  const cases = loadCases(fileURLToPath(new URL("../../../conformance", import.meta.url))); // throws on any bad header
  const n = (k: string) => cases.filter((c) => c.kind === k).length;
  expect(n("accept")).toBeGreaterThanOrEqual(20);
  expect(n("reject")).toBeGreaterThanOrEqual(50);
  expect(n("run")).toBeGreaterThanOrEqual(10);
});
