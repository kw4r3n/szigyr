import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitC } from "../src/emit-c.ts";
import { analyze, CLI_NAME, run } from "../src/index.ts";
import { compileWasm } from "../src/wasm.ts";
import * as rt from "../../runtime-js/src/index.ts";

function tmpFile(name: string, src: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-wasm-slice-`));
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
}

describe("wasm partial buffer copy", () => {
  it("pins only slice bytes on a 32 MB Vec without expanding Wasm linear memory", () => {
    const f = tmpFile("slice32mb.szigyr", `
export function xorSlice(s: Mut<Slice<u8>>, val: u8): u8 {
  "use rt";
  let sum: u8 = 0;
  let i: usize = 0;
  while (i < s.length) {
    s[i] = u8(u32(s[i]) ^ u32(val));
    sum = u8(u32(sum) ^ u32(s[i]));
    i += 1;
  }
  return sum;
}
`);
    const a = analyze(f);
    expect(a.diagnostics).toEqual([]);
    const c = emitC(a.decls!, "wasm")!;
    const wasmBytes = compileWasm(c.c);
    const OrigInstance = WebAssembly.Instance;
    let capturedMem: WebAssembly.Memory | undefined;
    (globalThis.WebAssembly as { Instance: unknown }).Instance = function (
      m: WebAssembly.Module,
      imp?: WebAssembly.Imports,
    ) {
      const inst = new OrigInstance(m, imp);
      capturedMem = inst.exports.memory as WebAssembly.Memory;
      return inst;
    };
    let api: Record<string, (...a: unknown[]) => unknown>;
    try {
      api = rt.instantiateWasm(wasmBytes as BufferSource, c.meta!, rt.NATIVE_HOST);
    } finally {
      (globalThis.WebAssembly as { Instance: unknown }).Instance = OrigInstance;
    }
    const baseMem = capturedMem!.buffer.byteLength;
    expect(baseMem).toBeLessThan(4 * 1024 * 1024);

    // Build a 32 MB Vec<u8> and slice 16 bytes in the middle.
    const raw = new Uint8Array(32 * 1024 * 1024);
    raw[16_000_000 - 1] = 0xaa;
    for (let i = 0; i < 16; i++) raw[16_000_000 + i] = i + 1;
    raw[16_000_016] = 0xbb;
    const vec = rt.Vec.unpack<number>({ elem: "u8", buf: raw.buffer });

    const fnKey = Object.keys(c.meta!.fns)[0]!;
    const xorSlice = api[fnKey] as (s: rt.Slice<number>, val: number) => number;
    let sum = 0;
    for (let k = 0; k < 200; k++) {
      sum = xorSlice(vec.slice(16_000_000, 16_000_016), 0x0f);
    }
    // 200 is even, so XORing with 0x0f twice returns original bytes; xor 201st time to mutate.
    sum = xorSlice(vec.slice(16_000_000, 16_000_016), 0x0f);
    expect(sum).toBe(16); // (1..16) ^ 0x0f xored together == 16
    expect(vec.get(16_000_000 - 1)).toBe(0xaa);
    for (let i = 0; i < 16; i++) expect(vec.get(16_000_000 + i)).toBe((i + 1) ^ 0x0f);
    expect(vec.get(16_000_016)).toBe(0xbb);

    // Wasm linear memory must stay small (< 4 MB) even after calling xorSlice on a 32 MB Vec.
    expect(capturedMem!.buffer.byteLength).toBeLessThan(4 * 1024 * 1024);
  });

  it("handles large-cap Vec/Arena/Pool partial active ranges, slices, overlaps, and traps in Wasm", async () => {
    const f = tmpFile("partial-containers.szigyr", `
function dirtyHeap(n: usize): u32 {
  "use rt";
  let p: u32 = 0;
  let i: usize = 0;
  while (i < n) {
    p = wrapAdd(p, wrapMul(u32(i), 2654435761));
    i += 1;
  }
  return p;
}

function sumRefPair(a: Ref<Slice<u8>>, b: Ref<Slice<u8>>): u32 {
  "use rt";
  let acc: u32 = 0;
  let i: usize = 0;
  while (i < a.length) { acc += u32(a[i]); i += 1; }
  i = 0;
  while (i < b.length) { acc += u32(b[i]); i += 1; }
  return acc;
}

function swapMutPair(a: Mut<Slice<u8>>, b: Mut<Slice<u8>>): void {
  "use rt";
  if (a.length > 0 && b.length > 0) {
    const t: u8 = a[0];
    a[0] = b[0];
    b[0] = t;
  }
}

function vecPushAndGrow(v: Mut<Vec<u32>>, n: usize): u32 {
  "use owned";
  let i: usize = 0;
  while (i < n) {
    v.push(u32(i * 3 + 7));
    i += 1;
  }
  return v[v.length - 1];
}

function writeArenaSlice(s: Mut<Slice<u8>>): u8 {
  "use rt";
  s[0] = 42;
  s[15] = 99;
  return u8(u32(s[0]) + u32(s[15]));
}

function arenaAllocAndReset(a: Mut<Arena>, resetIt: boolean): u8 {
  "use rt";
  if (resetIt) a.reset();
  const b = a.alloc(16, u8(0));
  if (b === null) return 0;
  return writeArenaSlice(a.view(b));
}

function poolInsertRemove(p: Mut<Pool<u32>>): Handle<u32> {
  "use rt";
  const h1 = p.insert(100);
  if (h1 === null) panic("full");
  const h2 = p.insert(200);
  if (h2 === null) panic("full");
  p.remove(h1);
  const h3 = p.insert(300);
  if (h3 === null) panic("full");
  p.set(h2, p.get(h2) + p.get(h3));
  return h1;
}

function poolRead(p: Ref<Pool<u32>>, h: Handle<u32>): u32 {
  "use rt";
  return p.get(h);
}

export function main(sys: System): void {
  dirtyHeap(256);

  // Overlapping Ref slices + disjoint Mut slices + empty slices
  const v = Vec.create<u8>(sys.alloc, 1024);
  for (let i = 0; i < 16; i += 1) v.push(u8(i + 1));
  const refSum = sumRefPair(v.slice(2, 6), v.slice(4, 8)); // (3+4+5+6) + (5+6+7+8) = 44
  swapMutPair(v.slice(0, 4), v.slice(12, 16)); // swap [1] and [13]
  const emptySum = sumRefPair(v.slice(0, 0), v.slice(5, 5));
  sys.log.info(\`\${refSum},\${v[0]},\${v[12]},\${emptySum}\`);

  // Vec small len in larger cap, plus grow beyond initial cap
  const nums = Vec.create<u32>(sys.alloc, 64);
  nums.push(999);
  nums.clear();
  const last = vecPushAndGrow(nums, 100);
  sys.log.info(\`\${nums.length},\${nums[0]},\${last}\`);

  // Arena partial used + reset
  const ar = Arena.create(sys.alloc, 262144);
  const a1 = arenaAllocAndReset(ar, false);
  const a2 = arenaAllocAndReset(ar, true);
  sys.log.info(\`\${a1},\${a2}\`);

  // Pool large cap, small nextFresh (verifies zeroTail on gens/occ)
  const pool = Pool.create<u32>(sys.alloc, 8192);
  const stale = poolInsertRemove(pool);
  sys.log.info(\`\${pool.length}\`);
  // Trigger T011 on stale handle
  poolRead(pool, stale);
}
`);
    const res = await run(f, { backend: "wasm" });
    expect(res.diagnostics).toEqual([]);
    expect(res.trap?.code).toBe("T011");
    expect(res.stdout).toBe("44,13,1,0\n100,7,304\n141,141\n2\n");
  });

  it("still traps T013 on overlapping Mut slices in Wasm", async () => {
    const f = tmpFile("ovl-mut.szigyr", `
function copyFirst(dst: Mut<Slice<u8>>, src: Ref<Slice<u8>>): void {
  "use rt";
  dst[0] = src[0];
}
export function main(sys: System): void {
  const v = Vec.create<u8>(sys.alloc, 32);
  for (let i = 0; i < 8; i += 1) v.push(u8(i));
  copyFirst(v.slice(1, 5), v.slice(3, 7));
}
`);
    const res = await run(f, { backend: "wasm" });
    expect(res.trap?.code).toBe("T013");
  });
});
