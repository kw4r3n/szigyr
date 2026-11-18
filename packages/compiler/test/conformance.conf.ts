// Runs conformance/ against the real compiler. Run with `pnpm conformance` (STS_STAGE=N to limit).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as compiler from "../src/index.ts";
import { filterByStage, loadCases, runCase } from "./harness.ts";

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
const stage = process.env.STS_STAGE === undefined ? undefined : Number(process.env.STS_STAGE);
const cases = filterByStage(loadCases(root), stage);

describe("conformance", () => {
  it(`${cases.length} cases${stage === undefined ? "" : ` (stage <= ${stage})`}`, () => {});
  for (const c of cases) {
    it(c.name, async () => {
      expect(await runCase(c, compiler)).toEqual([]);
    });
  }
});
