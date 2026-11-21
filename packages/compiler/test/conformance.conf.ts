// Runs conformance/ against the real compiler. Run with `pnpm conformance` (SZIGYR_STAGE=N to limit).
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as compiler from "../src/index.ts";
import { atCSpecifier, filterByStage, loadCases, missingCPackages, parseStage, pkgExists, runCase } from "./harness.ts";
import { ensureSzcb } from "./szcb.ts";

// The szcb fixture (stage 3-6) is built before the cases load, so its cases do not skip.
ensureSzcb();

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
const stage = parseStage(process.env.SZIGYR_STAGE);
const cases = filterByStage(loadCases(root), stage);

/** D101 / Q280: stage 2+ run cases also run with strict / rt compiled to C and Wasm. */
const cBackend = { ...compiler, backend: "c" as const, run: (f: string) => compiler.run(f, { backend: "c" }) };
const wasmBackend = { ...compiler, backend: "wasm" as const, run: (f: string) => compiler.run(f, { backend: "wasm" }) };

/** §14.7: a `// backend: c` case needs the pkg-config packages its `c:` specifiers name.
 * Where one is unavailable the case is skipped (and counted below), never failed. */
const skipped: string[] = [];
/** Cases whose strict / rt code uses what the C backend does not translate yet (D102). They must fail with that error, so the list stays exact. */
const C_PENDING = new Set<string>([]); // stage-2 run cases the C backend does not translate yet (none since D105)

describe("conformance", () => {
  it(`${cases.length} cases${stage === undefined ? "" : ` (stage <= ${stage})`}`, () => {});
  for (const c of cases) {
    // §14.2: the header check also makes accept cases depend on their libraries, and an E2009
    // case anchored at a function name; a specifier-anchored E2009 fires in any environment.
    const missing = c.backend === "c" || c.kind === "accept" || (c.at?.code === "E2009" && !atCSpecifier(c)) ? missingCPackages(c, pkgExists) : [];
    if (missing.length) {
      skipped.push(`${c.name} (pkg-config: ${missing.join(", ")})`);
      it.skip(c.name, () => {});
      if (c.kind === "run" && c.stage >= 2) { it.skip(`${c.name} [c]`, () => {}); it.skip(`${c.name} [wasm]`, () => {}); }
      continue;
    }
    it(c.name, async () => {
      expect(await runCase(c, compiler)).toEqual([]);
    });
    if (c.kind === "run" && c.stage >= 2) {
      it(`${c.name} [c]`, async () => {
        if (C_PENDING.has(c.name)) expect((await runCase(c, cBackend)).join()).toMatch(/^threw CUnsupported: C backend: .* not supported/);
        else expect(await runCase(c, cBackend)).toEqual([]);
      });
      it(`${c.name} [wasm]`, async () => {
        expect(await runCase(c, wasmBackend)).toEqual([]);
      });
    }
  }
  if (skipped.length) console.log(`conformance: skipped ${skipped.length} case(s) needing an unavailable C library: ${skipped.join("; ")}`);
});
