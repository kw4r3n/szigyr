import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, queryFile, run } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const fxDir = mkdtempSync(join(tmpdir(), "szigyr-cffiv1-fx-"));
const prevPkgPath = process.env.PKG_CONFIG_PATH;
process.env.PKG_CONFIG_PATH = prevPkgPath ? `${fxDir}:${prevPkgPath}` : fxDir;

writeFileSync(join(fxDir, "cffiv1.h"), `#ifndef CFFIV1_H
#define CFFIV1_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CF_NEG -7
#define CF_HEX 0x80000010u
#define CF_FLT 2.5
#define CF_BOOL true
#define CF_STR "hello"
#define CF_OVERFLOW 0x100000000ULL
#define CF_OK_SZ 64
#define CF_BIG_SZ ((size_t)4294967296ULL)

enum CfEnum { CF_ENUM_ONE = 1, CF_ENUM_TWO = 2 };
extern const uint32_t CF_EXTERN_U32;
extern const uint64_t CF_EXTERN_U64;
extern const size_t CF_EXTERN_BIG_SZ;

typedef struct Inner {
  int32_t a;
  bool flag;
} Inner;

typedef struct Pair {
  int32_t first;
  int32_t second;
  int32_t hidden;
  enum CfEnum tag;
  Inner inner;
  const int32_t *cptr;
} Pair;

typedef struct Node {
  int32_t val;
  struct Node *next;
} Node;

typedef struct SizeBox {
  size_t sz;
} SizeBox;

typedef struct WithBits {
  unsigned bits : 3;
} WithBits;

struct Incomplete;
typedef struct SizeBox OpaqueTypedef;

void *cf_alloc(size_t n);
void cf_free(void *p);
void cf_init_pairs(Pair *p, int32_t *cell);
SizeBox *cf_big_size_box(void);
int32_t cf_sum_pair(const Pair *p);
#endif
`);

writeFileSync(join(fxDir, "cffiv1.c"), `#include "cffiv1.h"
#include <stdlib.h>
const uint32_t CF_EXTERN_U32 = 777u;
const uint64_t CF_EXTERN_U64 = 999ULL;
const size_t CF_EXTERN_BIG_SZ = (size_t)4294967296ULL;

void *cf_alloc(size_t n) { return calloc(1, n); }
void cf_free(void *p) { free(p); }

void cf_init_pairs(Pair *p, int32_t *cell) {
  *cell = 55;
  p[0].first = 10; p[0].second = 20; p[0].hidden = 999; p[0].tag = CF_ENUM_TWO;
  p[0].inner.a = 3; p[0].inner.flag = true; p[0].cptr = cell;
  p[1].first = 40; p[1].second = 50; p[1].hidden = 888; p[1].tag = CF_ENUM_ONE;
  p[1].inner.a = 7; p[1].inner.flag = false; p[1].cptr = cell;
}

SizeBox *cf_big_size_box(void) {
  static SizeBox b = { (size_t)4294967296ULL };
  return &b;
}

int32_t cf_sum_pair(const Pair *p) {
  return p->first + p->second + p->hidden;
}
`);

execFileSync("cc", ["-std=gnu11", "-O2", "-shared", "-fPIC", join(fxDir, "cffiv1.c"), "-o", join(fxDir, "libcffiv1.so")]);
writeFileSync(join(fxDir, "cffiv1.pc"), `prefix=\${pcfiledir}
Name: cffiv1
Description: Szigyr v1 C FFI test fixture
Version: 1
Libs: -L\${prefix} -lcffiv1 -Wl,-rpath,\${prefix}
Cflags: -I\${prefix}
`);

const workDir = mkdtempSync(join(tmpdir(), "szigyr-cffiv1-src-"));
let idx = 0;
function writeMod(src: string): string {
  const f = join(workDir, `m${++idx}.szigyr`);
  writeFileSync(f, src);
  return f;
}

afterAll(() => {
  if (prevPkgPath === undefined) delete process.env.PKG_CONFIG_PATH;
  else process.env.PKG_CONFIG_PATH = prevPkgPath;
  rmSync(fxDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("C FFI v1: const, CStruct, Ptr.null, Ptr.sizeOf", () => {
  it("reads C macros, enums, and extern consts on the C backend and traps T003 on usize overflow", async () => {
    const f = writeMod(`
declare module "c:cffiv1:cffiv1.h" {
  const CF_NEG: i32;
  const CF_HEX: u32;
  const CF_FLT: f64;
  const CF_BOOL: boolean;
  const CF_ENUM_TWO: u32;
  const CF_EXTERN_U32: u32;
  const CF_OK_SZ: usize;
  const CF_EXTERN_BIG_SZ: usize;
}
import { CF_NEG, CF_HEX as aliasHex, CF_FLT, CF_BOOL, CF_ENUM_TWO, CF_EXTERN_U32, CF_OK_SZ, CF_EXTERN_BIG_SZ } from "c:cffiv1:cffiv1.h";

function shadowed(CF_NEG: i32): i32 {
  "use owned";
  "use unsafe";
  return CF_NEG;
}
type Out = Struct<{ neg: i32; hexOk: boolean; flt: f64; b: boolean; en: u32; ext: u32; sz: usize; sh: i32 }>;
function gather(): Out {
  "use owned";
  "use unsafe";
  return {
    neg: CF_NEG,
    hexOk: aliasHex === 0x80000010,
    flt: CF_FLT,
    b: CF_BOOL,
    en: CF_ENUM_TWO,
    ext: CF_EXTERN_U32,
    sz: CF_OK_SZ,
    sh: shadowed(123),
  };
}
function triggerBigRt(): usize {
  "use rt";
  "use unsafe";
  return CF_EXTERN_BIG_SZ;
}
function triggerBig(): usize {
  "use owned";
  "use unsafe";
  return CF_EXTERN_BIG_SZ;
}
export function main(sys: System): void {
  const o = gather();
  sys.log.info(\`\${o.neg} \${o.hexOk} \${o.flt} \${o.b} \${o.en} \${o.ext} \${o.sz} \${o.sh}\`);
  sys.log.info(\`\${triggerBig()}\`);
}
`);
    const q = queryFile(f);
    expect(q.diagnostics).toEqual([]);
    const trig = q.symbols.find((s) => s.name === "triggerBigRt");
    expect(trig?.rtTrapSites?.some((s) => s.code === "T003")).toBe(true);
    const res = await run(f, { backend: "c" });
    expect(res.diagnostics).toEqual([]);
    expect(res.stdout).toBe("-7 true 2.5 true 2 777 64 123\n");
    expect(res.trap?.code).toBe("T003");
  });

  it("rejects mismatched C constants in P4 (E2009) and unsafe/type rules in P2", () => {
    const cases: [string, string][] = [
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_NEG: u32; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_OVERFLOW: u32; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_BIG_SZ: usize; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_STR: i32; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_NO_SUCH: i32; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_EXTERN_U64: u32; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const BAD_S: string; }", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_NEG: i32; }\nimport { CF_NEG } from \"c:cffiv1:cffiv1.h\";\nfunction f(): i32 { return CF_NEG; }", "E4008"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_NEG: i32; }\nimport { CF_NEG } from \"c:cffiv1:cffiv1.h\";\nexport { CF_NEG };", "E7001"],
      ["declare module \"c:cffiv1:cffiv1.h\" { const CF_BOOL: boolean; }\nimport { CF_BOOL } from \"c:cffiv1:cffiv1.h\";\nfunction f(): i32 { \"use owned\"; \"use unsafe\"; requires(CF_BOOL); return 1; }", "E6002"],
    ];
    for (const [src, code] of cases) {
      const ds = check(writeMod(src));
      expect(ds.some((d) => d.code === code), `${src} -> ${JSON.stringify(ds.map((d) => d.code))}`).toBe(true);
    }
  });

  it("supports CStruct fields, nesting, self-ref pointers, partial fields, read/write/offset, CHandle, Ptr.null, Ptr.sizeOf, and Resource", async () => {
    const f = writeMod(`
declare module "c:cffiv1:cffiv1.h" {
  type Inner = CStruct<{ a: i32; flag: boolean }>;
  type Pair = CStruct<{ first: i32; second: i32; tag: u32; inner: Inner; cptr: ConstPtr<i32> }>;
  type Node = CStruct<{ val: i32; next: Ptr<Node> }>;
  type SizeBox = CStruct<{ sz: usize }>;
  function cf_alloc(ffi: Ffi, n: usize): Ptr<void>;
  function cf_free(ffi: Ffi, p: Ptr<void>): void;
  function cf_init_pairs(ffi: Ffi, p: Ptr<Pair>, cell: Ptr<i32>): void;
  function cf_big_size_box(ffi: Ffi): Ptr<SizeBox>;
  function cf_sum_pair(ffi: Ffi, p: ConstPtr<Pair>): i32;
}
import {
  Inner, Pair, Node, SizeBox,
  cf_alloc, cf_free, cf_init_pairs, cf_big_size_box, cf_sum_pair,
} from "c:cffiv1:cffiv1.h";

function releasePtr(ffi: Ffi, p: Ptr<void>): void {
  "use owned";
  "use unsafe";
  cf_free(ffi, p);
}

export function makePair(ffi: Ffi, first: i32, second: i32): CHandle<Pair> {
  "use owned";
  "use unsafe";
  using g = Resource.ownWith(cf_alloc(ffi, Ptr.sizeOf<Pair>()), ffi, releasePtr);
  if (g.get().isNull()) panic("oom");
  const base: Pair = { first: first, second: 0, tag: 1, inner: { a: 9, flag: true }, cptr: Ptr.null() };
  const updated: Pair = { ...base, second: second };
  g.get().cast<Pair>().write(updated);
  return CHandle.create(g.take().cast<Pair>());
}

type R = Struct<{
  s0: i32;
  s1First: i32;
  s1Tag: u32;
  s1InnerFlag: boolean;
  cptrVal: i32;
  sumZeroedHidden: i32;
  nodeSum: i32;
  sizesOk: boolean;
  nullsOk: boolean;
}>;

function exercise(ffi: Ffi, h: CHandle<Pair>): R {
  "use owned";
  "use unsafe";
  using hMem = Resource.ownWith(h.get().cast<void>(), ffi, releasePtr);
  using arrMem = Resource.ownWith(cf_alloc(ffi, Ptr.sizeOf<Pair>() * 2), ffi, releasePtr);
  using cellMem = Resource.ownWith(cf_alloc(ffi, Ptr.sizeOf<i32>()), ffi, releasePtr);
  const arr = arrMem.get().cast<Pair>();
  cf_init_pairs(ffi, arr, cellMem.get().cast<i32>());
  const cArr: ConstPtr<Pair> = arr;
  const { first: f0, inner } = cArr.read();
  const secondElem = cArr.offset(1).read();
  const cptrVal = secondElem.cptr.read();
  const hSum = cf_sum_pair(ffi, h.get());

  using n2m = Resource.ownWith(cf_alloc(ffi, Ptr.sizeOf<Node>()), ffi, releasePtr);
  using n1m = Resource.ownWith(cf_alloc(ffi, Ptr.sizeOf<Node>()), ffi, releasePtr);
  const n2 = n2m.get().cast<Node>();
  const n1 = n1m.get().cast<Node>();
  n2.write({ val: 11, next: Ptr.null() });
  n1.write({ val: 31, next: n2 });
  const nodeSum = n1.read().val + n1.read().next.read().val;

  const p0 = Ptr.null<i32>();
  const p1: ConstPtr<Pair> = Ptr.null();
  const box: SizeBox = { sz: 42 };
  const copySz = Ptr.sizeOf<{ readonly a: u8; readonly b: u32 }>();
  const sizesOk = Ptr.sizeOf<u8>() === 1 && Ptr.sizeOf<f64>() === 8 && copySz === 8 &&
    Ptr.sizeOf<Ptr<void>>() === 8 && Ptr.sizeOf<CType<"OpaqueTypedef">>() === Ptr.sizeOf<SizeBox>() &&
    box.sz === 42;
  return {
    s0: f0,
    s1First: secondElem.first,
    s1Tag: secondElem.tag,
    s1InnerFlag: inner.flag,
    cptrVal: cptrVal,
    sumZeroedHidden: hSum,
    nodeSum: nodeSum,
    sizesOk: sizesOk,
    nullsOk: p0.isNull() && p1.isNull() && Ptr.null<void>().isNull(),
  };
}

function readBigBoxRt(): usize {
  "use rt";
  "use unsafe";
  return cf_big_size_box().read().sz;
}
function readBigBox(ffi: Ffi): usize {
  "use owned";
  "use unsafe";
  return cf_big_size_box(ffi).read().sz;
}

export function main(sys: System): void {
  const h: CHandle<Pair> = makePair(sys.ffi, 4, 8);
  const r = exercise(sys.ffi, h);
  sys.log.info(\`\${r.s0} \${r.s1First} \${r.s1Tag} \${r.s1InnerFlag} \${r.cptrVal} \${r.sumZeroedHidden} \${r.nodeSum} \${r.sizesOk} \${r.nullsOk}\`);
  sys.log.info(\`\${readBigBox(sys.ffi)}\`);
}
`);
    const q = queryFile(f);
    expect(q.diagnostics).toEqual([]);
    const rb = q.symbols.find((s) => s.name === "readBigBoxRt");
    expect(rb?.rtTrapSites?.some((s) => s.code === "T003")).toBe(true);
    const res = await run(f, { backend: "c" });
    expect(res.diagnostics).toEqual([]);
    expect(res.stdout).toBe("10 40 1 true 55 12 42 true true\n");
    expect(res.trap?.code).toBe("T003");
  });

  it("traps T015 on null CStruct pointer read", async () => {
    const f = writeMod(`
declare module "c:cffiv1:cffiv1.h" {
  type SizeBox = CStruct<{ sz: usize }>;
}
import { SizeBox } from "c:cffiv1:cffiv1.h";
function readNil(): usize {
  "use owned";
  "use unsafe";
  const p = Ptr.null<SizeBox>();
  return p.read().sz;
}
export function main(sys: System): void {
  sys.log.info(\`\${readNil()}\`);
}
`);
    const res = await run(f, { backend: "c" });
    expect(res.diagnostics).toEqual([]);
    expect(res.trap?.code).toBe("T015");
  });

  it("rejects invalid CStruct / Ptr.null / Ptr.sizeOf constructs across P2 and P4", () => {
    const cases: [string, string][] = [
      // P4 layout checks
      ["declare module \"c:cffiv1:cffiv1.h\" { type NoSuch = CStruct<{ a: i32 }>; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ missingField: i32 }>; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: f64 }>; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: u32 }>; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type WithBits = CStruct<{ bits: u32 }>; }", "E2009"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; }\nfunction f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<CType<\"Incomplete\">>(); }", "E2009"],
      // P2 CStruct validity
      ["type S = CStruct<{ a: i32 }>;", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; function cf_sum_pair(ffi: Ffi, p: Pair): i32; }", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Bad = CStruct<{ p: ConstPtr<() => void> }>; }", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Bad = CStruct<{ p: Ptr<usize> }>; }", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Bad = CStruct<{ v: Vec<i32> }>; }", "E4007"],
      // Cycles
      ["declare module \"c:cffiv1:cffiv1.h\" { type S = CStruct<{ s: S }>; }", "E2002"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type A = CStruct<{ b: B }>; type B = CStruct<{ a: A }>; }", "E2002"],
      // Safe code barriers for CStruct
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; }\nimport { Pair } from \"c:cffiv1:cffiv1.h\";\nfunction bad(p: Pair): i32 { \"use owned\"; return p.first; }", "E4008"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; }\nimport { Pair } from \"c:cffiv1:cffiv1.h\";\nfunction mk(): Pair { \"use owned\"; \"use unsafe\"; return { first: 1 }; }\nexport function caller(): i32 { \"use owned\"; return mk().first; }", "E4008"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; }\nimport { Pair } from \"c:cffiv1:cffiv1.h\";\ntype Wrap = Struct<{ p: Pair }>;", "E4008"],
      // Ptr.null / Ptr.sizeOf errors
      ["function f(): Ptr<i32> { \"use owned\"; return Ptr.null<i32>(); }", "E4008"],
      ["function f(): Ptr<string> { \"use owned\"; \"use unsafe\"; return Ptr.null<string>(); }", "E4007"],
      ["function f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<void>(); }", "E4007"],
      ["function f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<() => void>(); }", "E4007"],
      ["function f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<string>(); }", "E4007"],
      ["function f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<Vec<i32>>(); }", "E4007"],
      ["declare module \"c:cffiv1:cffiv1.h\" { type Pair = CStruct<{ first: i32 }>; }\nimport { Pair } from \"c:cffiv1:cffiv1.h\";\nfunction f(): usize { \"use owned\"; \"use unsafe\"; return Ptr.sizeOf<CHandle<Pair>>(); }", "E4007"],
    ];
    for (const [src, code] of cases) {
      const ds = check(writeMod(src));
      expect(ds.some((d) => d.code === code), `${src} -> ${JSON.stringify(ds)}`).toBe(true);
    }
  });

  it("supports queryFile and mutateFile alongside C const and CStruct declarations", async () => {
    const f = writeMod(`
declare module "c:cffiv1:cffiv1.h" {
  const CF_NEG: i32;
  type Pair = CStruct<{ first: i32; second: i32 }>;
}
import { CF_NEG, Pair } from "c:cffiv1:cffiv1.h";
function unsafeRead(): i32 {
  "use owned";
  "use unsafe";
  const p: Pair = { first: CF_NEG, second: 1 };
  return p.first + p.second;
}
export function add(a: i32, b: i32): i32 {
  return a + b;
}
test("add", (t: Test) => {
  t.eq(add(2, 3), 5);
});
`);
    const q = queryFile(f);
    expect(q.diagnostics).toEqual([]);
    const cSym = q.symbols.find((s) => s.name === "CF_NEG");
    const tSym = q.symbols.find((s) => s.name === "Pair");
    expect(cSym).toMatchObject({ kind: "const", type: "i32", unsafe: true });
    expect(tSym).toMatchObject({ kind: "type", type: "Pair", unsafe: true });
    const m = await mutateFile(f, { cache: false });
    expect(m.diagnostics).toEqual([]);
    expect(m.summary.targets).toBe(1);
    expect(m.summary.skipped).toEqual([{ fn: "unsafeRead", reason: "unsafe" }]);
    expect(m.mutants.some((x) => x.fn === "add" && x.status === "killed")).toBe(true);
    expect(m.summary.killed).toBeGreaterThan(0);
  });
});
