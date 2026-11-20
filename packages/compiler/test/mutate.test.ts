import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mutate } from "../src/index.ts";
import { CLI_NAME } from "../src/names.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const sts = (cwd: string, ...a: string[]) => {
  const r = spawnSync("node", [CLI, ...a], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const jsonLines = (s: string): any[] =>
  s
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function tmpFile(name: string, src: string): { dir: string; file: string; cacheFile: string } {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-mut-`));
  const file = join(dir, name);
  writeFileSync(file, src);
  return { dir, file, cacheFile: join(dir, ".sts-cache", "mutate.json") };
}

describe("mutate: 6 operators and contract exclusion", () => {
  it("generates all 6 operators, excludes contracts, tags survived delete-stmt as deadCode", async () => {
    const src = `function noop(): void {}
function ops(a: i32, b: i32, flag: boolean, s: string): string {
  requires(a >= 0 && b >= 0);
  ensures((r: string) => r.length > 0);
  let x: i32 = a + b;
  let y: i32 = a - b;
  let z: i32 = a * b;
  let dead: i32 = 0;
  dead = 5;
  dead += 1;
  noop();
  if (x < y && flag) {
    return \`\${s}!\`;
  }
  if (z === 0 || !flag) {
    return "zero";
  }
  if (x > 100 || y >= 100 || z <= -100 || a !== 999) {
    return "big";
  }
  if (true) {
    return "pos";
  }
  return "other";
}
test("weak", (t: Test) => {
  t.eq(ops(1, 2, true, "hi"), "big");
});
`;
    const { file, cacheFile } = tmpFile("ops.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();

    const ops = new Set(res.mutants.map((m) => m.op));
    // Op 1: +, -, *
    expect(ops.has("+ -> -")).toBe(true);
    expect(ops.has("- -> +")).toBe(true);
    expect(ops.has("* -> +")).toBe(true);

    // Op 2: <, <=, >, >=, ===, !==
    expect(ops.has("< -> <=")).toBe(true);
    expect(ops.has("<= -> <")).toBe(true);
    expect(ops.has("> -> >=")).toBe(true);
    expect(ops.has(">= -> >")).toBe(true);
    expect(ops.has("=== -> !==")).toBe(true);
    expect(ops.has("!== -> ===")).toBe(true);
    // Op 3: &&, ||
    expect(ops.has("&& -> ||")).toBe(true);
    expect(ops.has("|| -> &&")).toBe(true);
    // Op 4: if -> true / false (and skipped on `if (true)` on line 21!)
    expect(ops.has("if -> true")).toBe(true);
    expect(ops.has("if -> false")).toBe(true);
    const ifTrueMutants = res.mutants.filter((m) => (m.op === "if -> true" || m.op === "if -> false") && m.range.start.line === 21);
    expect(ifTrueMutants).toEqual([]);

    // Op 5: true -> false, 0 -> 1, num -> 0
    expect(ops.has("true -> false")).toBe(true);
    expect(ops.has("0 -> 1")).toBe(true);
    expect(ops.has("num -> 0")).toBe(true);

    // Op 6: delete-stmt on `dead = 5;`, `dead += 1;`, `noop();` -> survived with deadCode: true
    const deadMutants = res.mutants.filter((m) => m.op === "delete-stmt" && m.status === "survived");
    expect(deadMutants.length).toBeGreaterThanOrEqual(3);
    for (const m of deadMutants) expect(m.deadCode).toBe(true);

    // Contract lines (lines 3 and 4) must have ZERO mutants!
    const contractMutants = res.mutants.filter((m) => m.range.start.line === 3 || m.range.start.line === 4);
    expect(contractMutants).toEqual([]);
  });

  it("does not mutate invariant() expressions or switch case labels", async () => {
    const src = `function loopAndSwitch(n: i32, b: boolean): i32 {
  let i: i32 = 0;
  while (i < n) {
    invariant(i >= 0 && i <= n);
    i += 1;
  }
  switch (b) {
    case true: return i;
    case false: return -1;
  }
}
test("basic", (t: Test) => {
  t.eq(loopAndSwitch(3, true), 3);
  t.eq(loopAndSwitch(2, false), -1);
});
`;
    const { file, cacheFile } = tmpFile("inv.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Line 4 is invariant(...) -> zero mutants
    expect(res.mutants.filter((m) => m.range.start.line === 4)).toEqual([]);
    // Lines 8 and 9 are case true: / case false: -> no boolean literal mutants on case expressions
    expect(res.mutants.filter((m) => (m.op === "true -> false" || m.op === "false -> true"))).toEqual([]);
    // Negative literal `-1` on line 9 should be mutated to `0` and killed by test
    const negLit = res.mutants.find((m) => m.range.start.line === 9 && m.op === "num -> 0");
    expect(negLit).toBeDefined();
    expect(negLit!.status).toBe("killed");
  });

  it("preserves type narrowing and ownership soundness when generating mutants", async () => {
    const src = `type Opt = { readonly val: i32 } | null;
function readOpt(x: Opt): i32 {
  if (x !== null) {
    return x.val + 1;
  }
  return 0;
}
function andNarrow(x: Opt): boolean {
  return x !== null && x.val > 0;
}
function rhsNarrow(flag: boolean, x: Opt): i32 {
  if (flag && x !== null) {
    return x.val;
  }
  return 0;
}
function assignNarrow(flag: boolean): i32 {
  let x: i32 | null = null;
  x = 5;
  if (flag) return x + 1;
  return x;
}
function moveReinit(v: Vec<i32>): usize {
  "use owned";
  let a = v;
  const n = a.length;
  if (n > 0) {
    return a.length;
  }
  return 0;
}
test("sound", (t: Test) => {
  t.eq(readOpt({ val: 10 }), 11);
  t.eq(readOpt(null), 0);
  t.eq(andNarrow({ val: 2 }), true);
  t.eq(andNarrow(null), false);
  t.eq(rhsNarrow(true, { val: 7 }), 7);
  t.eq(rhsNarrow(true, null), 0);
  t.eq(assignNarrow(true), 6);
  t.eq(assignNarrow(false), 5);
  const v = Vec.create<i32>(TestAlloc.create(), 2);
  v.push(1);
  t.eq(moveReinit(v), 1);
});
`;
    const { file, cacheFile } = tmpFile("sound.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Must complete cleanly with no uncaught TypeErrors
    expect(res.mutants.length).toBeGreaterThan(0);
  });
});

describe("mutate: target selection & C-only mixed files (Q275)", () => {
  it("selects only safe deterministic top-level functions and skips non-deterministic ones silently", async () => {
    const src = `function pureAdd(a: i32, b: i32): i32 {
  return a + b;
}
function withLog(log: Log, x: i32): i32 {
  log.info("hi");
  return x + 1;
}
function withAlloc(a: Alloc): usize {
  "use owned";
  const v = Vec.create<i32>(a, 2);
  return v.length;
}
function withCb(f: (x: i32) => i32, x: i32): i32 {
  return f(x + 1);
}
test("all", (t: Test) => {
  t.eq(pureAdd(2, 3), 5);
  const log = MemoryLog.create();
  t.eq(withLog(log, 4), 5);
  t.eq(withAlloc(TestAlloc.create()), 0);
  t.eq(withCb((x: i32) => x, 1), 2);
});
`;
    const { file, cacheFile } = tmpFile("select.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    const fns = new Set(res.mutants.map((m) => m.fn));
    expect([...fns]).toEqual(["pureAdd"]);
  });

  it("handles C-only declarations and unsafe functions without E4009, skipping C-only tests", async () => {
    const src = `declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_libversion_number(ffi: Ffi): i32;
}
import { sqlite3_libversion_number } from "c:sqlite3:sqlite3.h";

function cWrapper(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  return sqlite3_libversion_number(ffi);
}
function unsafeNoC(x: i32): i32 {
  "use owned";
  "use unsafe";
  return x + 1;
}
function safeCalc(a: i32, b: i32): i32 {
  "use rt";
  return a + b;
}
test("calls unsafe stub", (t: Test) => {
  t.eq(unsafeNoC(1), 2);
});
test("pure safe test", (t: Test) => {
  t.eq(safeCalc(3, 4), 7);
});
`;
    const { file, cacheFile } = tmpFile("mixed.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Only safeCalc is mutated, and pure safe test kills its mutant
    expect(res.mutants.length).toBeGreaterThan(0);
    expect(res.mutants.every((m) => m.fn === "safeCalc")).toBe(true);
    expect(res.mutants.every((m) => m.status === "killed")).toBe(true);
  });
});

describe("mutate: timeout detection & reachability (Q276)", () => {
  it("aborts mutant-induced infinite loops and marks them timeout (not survived)", async () => {
    const src = `function countUp(n: i32): i32 {
  "use rt";
  let i: i32 = 0;
  while (i < n) {
    i += 1;
  }
  return i;
}
test("countUp", (t: Test) => {
  t.eq(countUp(0), 0);
  t.eq(countUp(5), 5);
});
`;
    const { file, cacheFile } = tmpFile("loop.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Deleting `i += 1;` or changing `1 -> 0` creates an infinite loop -> status: "timeout"
    const timeouts = res.mutants.filter((m) => m.status === "timeout");
    expect(timeouts.length).toBeGreaterThanOrEqual(2);
    expect(res.summary.timeout).toBe(timeouts.length);
    expect(res.summary.survived).toBe(0);
  });
});

describe("mutate: witness search & shrinking (Q277)", () => {
  it("finds and shrinks a witness for a survived mutant", async () => {
    const src = `function clampNonNeg(x: i32): i32 {
  if (x < 0) {
    return 0;
  }
  return x;
}
test("only positive", (t: Test) => {
  t.eq(clampNonNeg(5), 5);
});
`;
    const { file, cacheFile } = tmpFile("witness.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    const ifFalse = res.mutants.find((m) => m.op === "if -> false");
    expect(ifFalse).toBeDefined();
    expect(ifFalse!.status).toBe("survived");
    expect(ifFalse!.witness).not.toBeNull();
    // Shrunk witness for x < 0 should be x = -1 (base: 0, mutant: -1)
    expect(ifFalse!.witness!.args).toEqual([-1]);
    expect(ifFalse!.witness!.base).toBe(0);
    expect(ifFalse!.witness!.mutant).toBe(-1);
  });

  it("detects witness differences in Mut<Slice<T>> and Mut<Struct<...>> parameters", async () => {
    const src = `type Acc = Struct<{ total: i32 }>;
function addToAcc(a: Mut<Acc>, s: Ref<Slice<i32>>, apply: boolean): void {
  "use rt";
  if (apply) {
    for (let i: usize = 0; i < s.length; i += 1) {
      a.total += s[i];
    }
  }
}
test("only apply=false", (t: Test) => {
  const a: Acc = { total: 0 };
  const v = Vec.create<i32>(TestAlloc.create(), 1);
  addToAcc(a, v, false);
  t.eq(a.total, 0);
});
`;
    const { file, cacheFile } = tmpFile("mut-witness.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    const ifFalse = res.mutants.find((m) => m.op === "if -> false");
    expect(ifFalse).toBeDefined();
    expect(ifFalse!.status).toBe("survived");
    expect(ifFalse!.witness).not.toBeNull();
    expect(ifFalse!.witness!.base).not.toEqual(ifFalse!.witness!.mutant);
  });

  it("skips own leading requires T004, but detects callee and recursive requires T004 as witnesses", async () => {
    const src = `function mustBePos(y: i32): i32 {
  requires(y > 0);
  return y;
}
function caller(x: i32): i32 {
  requires(x >= 1);
  if (x === 1) {
    return 1;
  }
  return mustBePos(x - 1);
}
function recDown(n: i32, go: boolean): i32 {
  requires(n >= 0);
  if (!go) {
    return 0;
  }
  if (n === 0) {
    return 0;
  }
  return recDown(n - 1, true);
}
test("only x=2 and go=false", (t: Test) => {
  t.eq(caller(2), 1);
  t.eq(recDown(1, false), 0);
});
`;
    const { file, cacheFile } = tmpFile("req-witness.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    // In `caller`, test only calls caller(2) where `x === 1` is false, so `if (x === 1) -> false` survives!
    // Witness search tests `x = 1` (passes caller's `requires(x >= 1)`), where base returns 1 and mutant traps T004 inside mustBePos(0).
    const ifFalse = res.mutants.find((m) => m.fn === "caller" && m.op === "if -> false");
    expect(ifFalse).toBeDefined();
    expect(ifFalse!.status).toBe("survived");
    expect(ifFalse!.witness).not.toBeNull();
    expect(ifFalse!.witness!.args).toEqual([1]);
    expect(ifFalse!.witness!.base).toBe(1);
    expect(ifFalse!.witness!.mutant).toEqual({ trap: "T004" });

    // In `recDown`, test only calls recDown(1, false), so `if (n === 0) -> false` survives!
    // For `[0, true]`, outer `requires(n >= 0)` passes, then mutant recurses `recDown(-1, true)` which traps T004 at depth 2!
    const recIfFalse = res.mutants.find((m) => m.fn === "recDown" && m.op === "if -> false" && m.range.start.line === 17);
    expect(recIfFalse).toBeDefined();
    expect(recIfFalse!.status).toBe("survived");
    expect(recIfFalse!.witness).not.toBeNull();
    expect(recIfFalse!.witness!.args).toEqual([0, true]);
    expect(recIfFalse!.witness!.base).toBe(0);
    expect(recIfFalse!.witness!.mutant).toEqual({ trap: "T004" });
  });

  it("detects witness differences for timeout, Mut<Slice<f32>> (mixInto), and Mut<Vec<i32>>", async () => {
    const src = `function spinIfNeg(x: i32): i32 {
  if (x < 0) {
    let i: i32 = 0;
    while (i < 5) {
      i += 1;
    }
    return i;
  }
  return x;
}
function mixInto(out: Mut<Slice<f32>>, src: Ref<Slice<f32>>, gain: f32): void {
  "use rt";
  requires(out.length === src.length);
  for (let i: usize = 0; i < out.length; i += 1) {
    out[i] = out[i] + src[i] * gain;
  }
}
function clearVec(v: Mut<Vec<i32>>, doClear: boolean): void {
  "use owned";
  if (doClear) {
    v.clear();
  }
}
test("weak", (t: Test) => {
  t.eq(spinIfNeg(2), 2);
  const a = Vec.create<f32>(TestAlloc.create(), 0);
  const b = Vec.create<f32>(TestAlloc.create(), 0);
  mixInto(a, b, 1);
  const c = Vec.create<i32>(TestAlloc.create(), 1);
  clearVec(c, false);
  t.eq(c.length, 0);
});
`;
    const { file, cacheFile } = tmpFile("adv-witness.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);

    // In spinIfNeg, deleting `i += 1;` survives (test only passes x=2), and witness detects timeout!
    const delInc = res.mutants.find((m) => m.fn === "spinIfNeg" && m.op === "delete-stmt");
    expect(delInc).toBeDefined();
    expect(delInc!.status).toBe("survived");
    expect(delInc!.witness).not.toBeNull();
    expect(delInc!.witness!.mutant).toEqual({ timeout: true });

    // In mixInto, `out[i] = ...` deleted survives (test only uses empty slices); witness finds non-empty equal-length slices!
    const mixDel = res.mutants.find((m) => m.fn === "mixInto" && m.op === "delete-stmt");
    expect(mixDel).toBeDefined();
    expect(mixDel!.status).toBe("survived");
    expect(mixDel!.witness).not.toBeNull();
    expect(mixDel!.witness!.base).not.toEqual(mixDel!.witness!.mutant);

    // In clearVec, `v.clear();` deleted survives (test only passes doClear=false); witness finds non-empty Vec + true!
    const vecDel = res.mutants.find((m) => m.fn === "clearVec" && m.op === "delete-stmt");
    expect(vecDel).toBeDefined();
    expect(vecDel!.status).toBe("survived");
    expect(vecDel!.witness).not.toBeNull();
    expect(vecDel!.witness!.base).toEqual({ mut: { v: [] } });
  });

  it("handles generic and 0-param functions cleanly with witness: null", async () => {
    const src = `function zeroParam(): i32 {
  return 1 + 2;
}
function idNum<T>(x: T, flag: boolean): T {
  if (flag) {
    return x;
  }
  return x;
}
test("none", (t: Test) => {
  t.ok(true);
});
`;
    const { file, cacheFile } = tmpFile("gen-zero.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.mutants.length).toBeGreaterThan(0);
    for (const m of res.mutants) {
      expect(m.status).toBe("survived");
      expect(m.witness).toBeNull();
    }
  });

  it("attaches witness: null for equivalent mutants and non-generatable functions", async () => {
    const src = `class Box {
  readonly v: i32;
  constructor(v: i32) { this.v = v; }
}
function nonGen(b: Box): i32 {
  return b.v + 1;
}
function equiv(x: i32): i32 {
  return x + 0;
}
test("none", (t: Test) => {
  t.ok(true);
});
`;
    const { file, cacheFile } = tmpFile("null-witness.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    const ng = res.mutants.find((m) => m.fn === "nonGen" && m.op === "+ -> -");
    expect(ng).toBeDefined();
    expect(ng!.status).toBe("survived");
    expect(ng!.witness).toBeNull();

    const eq = res.mutants.find((m) => m.fn === "equiv" && m.op === "+ -> -");
    expect(eq).toBeDefined();
    expect(eq!.status).toBe("survived");
    expect(eq!.witness).toBeNull();
  });
});

describe("mutate: diff cache (Q277)", () => {
  it("caches per-function results, invalidates on callee change or new reaching test, and honors --no-cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-cache-`));
    const helperFile = join(dir, "helper.ts");
    const mainFile = join(dir, "main.ts");
    const cacheFile = join(dir, ".sts-cache", "mutate.json");

    writeFileSync(helperFile, `export function bump(x: i32): i32 {\n  return x + 1;\n}\n`);
    writeFileSync(
      mainFile,
      `import { bump } from "./helper.ts";
function f(x: i32): i32 {
  return bump(x) + 2;
}
function g(x: i32): i32 {
  return x * 3;
}
test("f", (t: Test) => {
  t.eq(f(1), 4);
});
test("g", (t: Test) => {
  t.eq(g(2), 6);
});
`
    );

    // 1. --no-cache does not write cache file
    const noCache = await mutate(mainFile, { cache: false, cacheFile });
    expect(existsSync(cacheFile)).toBe(false);
    expect(noCache.summary.cached).toBe(0);

    // 2. First cached run populates cache
    const r1 = await mutate(mainFile, { cache: true, cacheFile });
    expect(existsSync(cacheFile)).toBe(true);
    expect(r1.summary.cached).toBe(0);
    expect(r1.mutants.every((m) => !m.cached)).toBe(true);

    // 3. Second run hits cache for both f and g
    const r2 = await mutate(mainFile, { cache: true, cacheFile });
    expect(r2.summary.cached).toBe(r2.mutants.length);
    expect(r2.mutants.every((m) => m.cached)).toBe(true);

    // 4. Editing helper.ts (transitive callee of f, NOT g) invalidates ONLY f!
    writeFileSync(helperFile, `export function bump(x: i32): i32 {\n  return x + 10;\n}\n`);
    writeFileSync(
      mainFile,
      `import { bump } from "./helper.ts";
function f(x: i32): i32 {
  return bump(x) + 2;
}
function g(x: i32): i32 {
  return x * 3;
}
test("f", (t: Test) => {
  t.eq(f(1), 13);
});
test("g", (t: Test) => {
  t.eq(g(2), 6);
});
`
    );
    const r3 = await mutate(mainFile, { cache: true, cacheFile });
    expect(r3.mutants.filter((m) => m.fn === "f").every((m) => !m.cached)).toBe(true);
    expect(r3.mutants.filter((m) => m.fn === "g").every((m) => m.cached)).toBe(true);

    // 5. Adding a new test reaching g invalidates ONLY g (f stays cached)!
    writeFileSync(
      mainFile,
      `import { bump } from "./helper.ts";
function f(x: i32): i32 {
  return bump(x) + 2;
}
function g(x: i32): i32 {
  return x * 3;
}
test("f", (t: Test) => {
  t.eq(f(1), 13);
});
test("g", (t: Test) => {
  t.eq(g(2), 6);
});
test("g zero", (t: Test) => {
  t.eq(g(0), 0);
});
`
    );
    const r4 = await mutate(mainFile, { cache: true, cacheFile });
    expect(r4.mutants.filter((m) => m.fn === "f").every((m) => m.cached)).toBe(true);
    expect(r4.mutants.filter((m) => m.fn === "g").every((m) => !m.cached)).toBe(true);

    // 6. Shifting lines above f still hits cache AND updates reported ranges to current line numbers!
    writeFileSync(
      mainFile,
      `// shifted line 1
// shifted line 2
import { bump } from "./helper.ts";
function f(x: i32): i32 {
  return bump(x) + 2;
}
function g(x: i32): i32 {
  return x * 3;
}
test("f", (t: Test) => {
  t.eq(f(1), 13);
});
test("g", (t: Test) => {
  t.eq(g(2), 6);
});
test("g zero", (t: Test) => {
  t.eq(g(0), 0);
});
`
    );
    const r5 = await mutate(mainFile, { cache: true, cacheFile });
    const fMut5 = r5.mutants.filter((m) => m.fn === "f");
    expect(fMut5.every((m) => m.cached)).toBe(true);
    expect(fMut5[0]!.range.start.line).toBe(5); // shifted from line 3 -> line 5!
  });
});

describe("mutate: CLI (sts mutate)", () => {
  it("supports multiple files and human-readable text mode", () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-multi-`));
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, 'function add(x: i32, y: i32): i32 { return x + y; }\ntest("add", (t: Test) => { t.eq(add(2, 3), 5); });\n');
    writeFileSync(b, 'function neg(x: i32): i32 { return x - 1; }\ntest("neg", (t: Test) => { t.eq(neg(5), 4); });\n');
    const rJson = sts(dir, "mutate", "--json", "--no-cache", a, b);
    expect(rJson.code).toBe(0);
    const ls = jsonLines(rJson.out);
    const summary = ls.at(-1);
    expect(summary.kind).toBe("summary");
    expect(summary.killed + summary.survived + summary.timeout).toBe(ls.length - 1);
    expect(new Set(ls.slice(0, -1).map((m) => m.fn))).toEqual(new Set(["add", "neg"]));

    const rText = sts(dir, "mutate", "--no-cache", a);
    expect(rText.code).toBe(0);
    expect(rText.out).toMatch(/killed.*timeout.*survived/);
  });
  it("exits 0 with JSON lines and summary even when mutants survive, and caches in .sts-cache/mutate.json", () => {
    const src = `function abs(x: i32): i32 {
  if (x < 0) return -x;
  return x;
}
test("pos", (t: Test) => {
  t.eq(abs(3), 3);
});
`;
    const { dir, file } = tmpFile("abs.ts", src);
    const r1 = sts(dir, "mutate", "--json", file);
    expect(r1.code).toBe(0);
    const ls1 = jsonLines(r1.out);
    const summary1 = ls1.at(-1);
    expect(summary1).toMatchObject({ kind: "summary", cached: 0 });
    expect(summary1.survived).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".sts-cache", "mutate.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, ".sts-cache", "mutate.json"), "utf8"));
    expect(Object.keys(saved).length).toBeGreaterThan(0);

    // Second run is cached
    const r2 = sts(dir, "mutate", "--json", file);
    expect(r2.code).toBe(0);
    const summary2 = jsonLines(r2.out).at(-1);
    expect(summary2.cached).toBe(ls1.length - 1);

    // --no-cache bypasses cache
    const r3 = sts(dir, "mutate", "--json", "--no-cache", file);
    expect(r3.code).toBe(0);
    expect(jsonLines(r3.out).at(-1).cached).toBe(0);
  });

  it("exits 1 on compile errors and on baseline m=0 test failure, and 2 on CLI errors", () => {
    const { dir, file: badType } = tmpFile("bad.ts", "function f(x: i32): f64 { return x; }\n");
    const rCompile = sts(dir, "mutate", "--json", badType);
    expect(rCompile.code).toBe(1);
    expect(jsonLines(rCompile.out)[0]).toMatchObject({ code: "E2002" });

    const { dir: dir2, file: badTest } = tmpFile(
      "fail.ts",
      'function add(a: i32, b: i32): i32 { return a + b; }\ntest("broken", (t: Test) => { t.eq(add(1, 2), 99); });\n'
    );
    const rFail = sts(dir2, "mutate", "--json", badTest);
    expect(rFail.code).toBe(1);

    // CLI errors -> exit 2
    expect(sts(dir, "mutate").code).toBe(2);
    expect(sts(dir, "mutate", "/no/such/file.ts").code).toBe(2);
    expect(sts(dir, "mutate", "--backend=c", badType).code).toBe(2);
  });

  it("supports forAll(...) tests inside sts mutate and kills mutants with property tests", async () => {
    const src = `function absSafe(x: i32): i32 {
  requires(x > -2147483648);
  ensures((r: i32) => r >= 0);
  if (x < 0) {
    return -x;
  }
  return x;
}
function addComm(a: i32, b: i32): i32 {
  requires(a >= -1000 && a <= 1000 && b >= -1000 && b <= 1000);
  return a + b;
}
test("forAll kills mutants in named and inline property tests", (t: Test) => {
  forAll(absSafe);
  forAll((a: i32, b: i32): boolean => {
    requires(a >= -1000 && a <= 1000 && b >= -1000 && b <= 1000);
    return addComm(a, b) === addComm(b, a);
  });
});
`;
    const { file, cacheFile } = tmpFile("forall-mut.ts", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // absSafe's `if (x < 0) -> false` must be killed by `forAll(absSafe)` via `ensures((r) => r >= 0)`!
    const absIfFalse = res.mutants.find((m) => m.fn === "absSafe" && m.op === "if -> false");
    expect(absIfFalse).toBeDefined();
    expect(absIfFalse!.status).toBe("killed");
    // addComm's `+ -> -` breaks commutativity and must be killed by inline `forAll`!
    const addSub = res.mutants.find((m) => m.fn === "addComm" && m.op === "+ -> -");
    expect(addSub).toBeDefined();
    expect(addSub!.status).toBe("killed");
  });
});
