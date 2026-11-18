// Runs conformance/ against the real compiler. Run with `pnpm conformance` (STS_STAGE=N to limit).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as compiler from "../src/index.ts";
import { filterByStage, loadCases, runCase } from "./harness.ts";

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
const stage = process.env.STS_STAGE === undefined ? undefined : Number(process.env.STS_STAGE);
const cases = filterByStage(loadCases(root), stage);

/** D101: stage 2+ run cases also run with strict / rt compiled to C. A missing C toolchain fails these cases (no skip). */
const cBackend = { ...compiler, run: (f: string) => compiler.run(f, { backend: "c" }) };
/** Cases whose strict / rt code uses what the C backend does not translate yet (D102). They must fail with that error, so the list stays exact. */
const C_PENDING = new Set<string>([]); // stage-2 run cases the C backend does not translate yet (none since D105)

describe("conformance", () => {
  it(`${cases.length} cases${stage === undefined ? "" : ` (stage <= ${stage})`}`, () => {});
  for (const c of cases) {
    it(c.name, async () => {
      expect(await runCase(c, compiler)).toEqual([]);
    });
    if (c.kind === "run" && c.stage >= 2) {
      it(`${c.name} [c]`, async () => {
        if (C_PENDING.has(c.name)) expect((await runCase(c, cBackend)).join()).toMatch(/^threw CUnsupported: C backend: .* not supported/);
        else expect(await runCase(c, cBackend)).toEqual([]);
      });
    }
  }
});
