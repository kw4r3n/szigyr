import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileWasm } from "../src/wasm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rtHeaderPath = resolve(here, "../src/c/sz_wasm_rt.h");
const fuzzSrcPath = resolve(here, "./fixtures/alloc_fuzz.c");

interface FuzzExports extends WebAssembly.Exports {
  fuzz(seed: number, steps: number, maxsz: number): number;
  fuzz_detail(): number;
  burst(n: number, size: number): number;
}

describe("wasm linear-memory allocator fuzz", () => {
  it("preserves free-list and coalescing invariants across randomized ops and bursts", async () => {
    const rtHeader = readFileSync(rtHeaderPath, "utf8");
    const fuzzSrc = readFileSync(fuzzSrcPath, "utf8").replace('#include "sz_wasm_rt.h"', rtHeader);
    const bytes = compileWasm(fuzzSrc) as Uint8Array<ArrayBuffer>;
    const env = new Proxy<Record<string, unknown>>(
      {},
      { get: (_t, name) => (name === "memory" ? undefined : () => 0) },
    );

    const cases: readonly (readonly [number, number, number])[] = [
      [1, 150_000, 200_000],
      [2, 150_000, 1_000],
      [3, 150_000, 3_000_000],
      [4, 150_000, 100_000],
    ];

    for (const [seed, steps, maxsz] of cases) {
      const { instance } = await WebAssembly.instantiate(bytes, { env: env as WebAssembly.ModuleImports });
      const exports = instance.exports as FuzzExports;
      const rc = exports.fuzz(seed, steps, maxsz);
      expect(rc, `seed=${seed} failed at step ${exports.fuzz_detail()}`).toBe(0);
    }

    const { instance } = await WebAssembly.instantiate(bytes, { env: env as WebAssembly.ModuleImports });
    const exports = instance.exports as FuzzExports;
    expect(exports.burst(40_000, 64)).toBe(40_000);
  });
});
