import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mutate } from "../src/index.ts";
import { CLI_NAME } from "../src/names.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const szigyr = (cwd: string, ...a: string[]) => {
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
  return { dir, file, cacheFile: join(dir, ".szigyr-cache", "mutate.json") };
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
    const { file, cacheFile } = tmpFile("ops.szigyr", src);
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
    const { file, cacheFile } = tmpFile("inv.szigyr", src);
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
    const { file, cacheFile } = tmpFile("sound.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Must complete cleanly with no uncaught TypeErrors
    expect(res.mutants.length).toBeGreaterThan(0);
  });
});

describe("mutate: target selection & C-only mixed files (Q275)", () => {
  it("selects Pure + Mutatable fns and class methods (Alloc/Log/Spawn/Port/callbacks) and skips System/Js/Ffi as not-mutatable", async () => {
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
  v.push(1);
  return v.length;
}
function withCb(f: (x: i32) => i32, x: i32): i32 {
  return f(x + 1);
}
class Acc {
  v: i32;
  constructor(v: i32) { this.v = v; }
  add(x: i32): i32 {
    this.v = this.v + x;
    return this.v;
  }
}
async function withPort(p: Port<i32, i32>): Promise<void> {
  const x = await p.recv();
  if (x !== null) p.send(x + 1);
}
async function withSpawn(sp: Spawn, x: i32): Promise<i32> {
  const p = sp.isolate(withPort);
  p.send(x);
  const y = await p.recv();
  p.close();
  return y ?? -1;
}
function withSys(sys: System): void {
  sys.log.info("skip");
}
function withJs(j: Js): void {}
test("all", async (t: Test) => {
  t.eq(pureAdd(2, 3), 5);
  const log = MemoryLog.create();
  t.eq(withLog(log, 4), 5);
  t.eq(withAlloc(TestAlloc.create()), 1);
  t.eq(withCb((x: i32) => x, 1), 2);
  const acc = new Acc(10);
  t.eq(acc.add(5), 15);
  t.eq(await withSpawn(FakeSpawn.create(), 7), 8);
});
`;
    const { file, cacheFile } = tmpFile("select.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    const fns = new Set(res.mutants.map((m) => m.fn));
    expect(fns).toEqual(new Set(["pureAdd", "withLog", "withAlloc", "withCb", "Acc.add", "withPort", "withSpawn"]));
    expect(res.summary.skipped).toEqual([
      { fn: "withSys", reason: "not-mutatable" },
      { fn: "withJs", reason: "not-mutatable" },
    ]);
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
    const { dir, file, cacheFile } = tmpFile("mixed.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Only safeCalc is mutated, and pure safe test kills its mutant
    expect(res.mutants.length).toBeGreaterThan(0);
    expect(res.mutants.every((m) => m.fn === "safeCalc")).toBe(true);
    expect(res.mutants.every((m) => m.status === "killed")).toBe(true);
    expect(res.summary.skippedTests).toEqual(["calls unsafe stub"]);

    const cliJson = szigyr(dir, "mutate", "--no-cache", "--json", file);
    expect(cliJson.code).toBe(0);
    expect(jsonLines(cliJson.out).find((l) => l.kind === "summary")?.skippedTests).toEqual(["calls unsafe stub"]);

    const cliText = szigyr(dir, "mutate", "--no-cache", file);
    expect(cliText.code).toBe(0);
    expect(cliText.out).toContain("1 c-only test(s) skipped");
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
    const { file, cacheFile } = tmpFile("loop.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Deleting `i += 1;` or changing `1 -> 0` creates an infinite loop -> status: "timeout"
    const timeouts = res.mutants.filter((m) => m.status === "timeout");
    expect(timeouts.length).toBeGreaterThanOrEqual(2);
    expect(res.summary.timeout).toBe(timeouts.length);
    expect(res.summary.survived).toBe(0);
  });

  it("orders reaching tests fastest-first so a slow test declared earlier does not bloat timeout budgets", async () => {
    const src = `function sumLoop(n: i32): i32 {
  let acc: i32 = 0;
  let i: i32 = 0;
  while (i < n) {
    acc += i + 1;
    i += 1;
  }
  return acc;
}
test("slow first", (t: Test) => {
  let k: i32 = 0;
  for (let j: i32 = 0; j < 80000; j += 1) {
    k = (k + j) & 255;
  }
  t.ok(k >= 0);
  t.eq(sumLoop(3), 6);
});
test("fast second", (t: Test) => {
  t.eq(sumLoop(0), 0);
  t.eq(sumLoop(3), 6);
});
`;
    const { file, cacheFile } = tmpFile("fast-first.szigyr", src);
    const t0 = performance.now();
    const res = await mutate(file, { cache: false, cacheFile });
    const elapsed = performance.now() - t0;
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.survived).toBe(0);
    expect(res.summary.timeout).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(5000);
  });

  it("enforces wall-clock deadline on heavy sync loops and drains timed-out async loops without corrupting later mutants", async () => {
    const src = `function paintN(surf: DisplaySurface, n: i32): void {
  const c: DisplayColor = { r: 10, g: 20, b: 30, a: 255 };
  let i: i32 = 0;
  while (i < n) {
    surf.clear(c);
    i += 1;
  }
}
async function eventLoop(display: Display): Promise<i32> {
  const opened = await display.open({ title: "t", width: 200, height: 200 });
  if (opened.kind === "err") return -1;
  await using surf = opened.value;
  let frames: i32 = 0;
  let running = true;
  while (running) {
    paintN(surf, 1);
    await surf.present();
    frames += 1;
    for (const ev of surf.pollEvents()) {
      if (ev.kind === "close") running = false;
    }
  }
  return frames;
}
function addOne(x: i32): i32 {
  return x + 1;
}
test("async display loop and addOne", async (t: Test) => {
  const d = FakeDisplay.create();
  d.pushEvent({ kind: "close" });
  t.eq(await eventLoop(d), 1);
  t.eq(addOne(4), 5);
  t.eq(addOne(-1), 0);
});
`;
    const { file, cacheFile } = tmpFile("zombie-async.szigyr", src);
    const t0 = performance.now();
    const res = await mutate(file, { cache: false, cacheFile });
    const elapsed = performance.now() - t0;
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.timeout).toBeGreaterThanOrEqual(2);
    const addOneMutants = res.mutants.filter((m) => m.fn === "addOne");
    expect(addOneMutants.length).toBeGreaterThan(0);
    for (const m of addOneMutants) expect(m.status).toBe("killed");
    expect(elapsed).toBeLessThan(10_000);
  });

  it("filters tests by per-mutant site reachability so unreached branches do not re-run heavy tests", async () => {
    const src = `function dispatch(branch: i32, x: i32): i32 {
  if (branch === 0) {
    let s: i32 = 0;
    for (let i: i32 = 0; i < 40000; i += 1) {
      s = (s + i + x) & 255;
    }
    return s;
  }
  if (branch === 1) {
    return x * 2 + 1;
  }
  return x + 99;
}
test("heavy branch 0", (t: Test) => {
  t.ok(dispatch(0, 3) >= 0);
});
test("fast branch 1", (t: Test) => {
  t.eq(dispatch(1, 0), 1);
  t.eq(dispatch(1, 5), 11);
});
`;
    const { file, cacheFile } = tmpFile("site-reach.szigyr", src);
    const t0 = performance.now();
    const res = await mutate(file, { cache: false, cacheFile });
    const elapsed = performance.now() - t0;
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Line 10 is inside `branch === 1` (`x * 2 + 1`), reached only by fast test & all killed
    const branch1Mutants = res.mutants.filter((m) => m.range.start.line === 10);
    expect(branch1Mutants.length).toBeGreaterThanOrEqual(3);
    for (const m of branch1Mutants) expect(m.status).toBe("killed");
    // Line 12 (`x + 99`) is never reached -> survived with witness
    const branch2Survived = res.mutants.filter((m) => m.range.start.line === 12 && m.status === "survived");
    expect(branch2Survived.length).toBeGreaterThanOrEqual(2);
    expect(branch2Survived.some((m) => m.witness !== null)).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("skips num -> 0 mutation on nonzero for-loop incrementor steps while still mutating 0 -> 1", async () => {
    const src = `function sumSteps(n: usize): usize {
  "use rt";
  let acc: usize = 0;
  for (let i: usize = 0; i < n; i += 1) {
    acc = wrapAdd(acc, i + 1);
  }
  for (let j: i32 = i32(n); j > 0; j -= 1) {
    acc = wrapAdd(acc, usize(j + 1));
  }
  for (let m: i32 = 0; m < i32(n); m -= -1) {
    acc = wrapAdd(acc, usize(m + 1));
  }
  return acc;
}
test("sumSteps", (t: Test) => {
  t.eq(sumSteps(0), usize(0));
  t.eq(sumSteps(4), usize(34));
});
`;
    const { file, cacheFile } = tmpFile("for-step-lit.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.timeout).toBe(0);
    expect(res.summary.survived).toBe(0);
    expect(res.mutants.some((m) => m.op === "num -> 0" && (m.range.start.line === 4 || m.range.start.line === 7 || m.range.start.line === 10))).toBe(false);

    const zSrc = `function zeroStep(k0: i32): i32 {
  for (let k: i32 = k0; k < 0; k += 0) {
    return k;
  }
  return k0;
}
test("zeroStep", (t: Test) => {
  t.eq(zeroStep(0), 0);
});
`;
    const z = tmpFile("for-step-zero.szigyr", zSrc);
    const zRes = await mutate(z.file, { cache: false, cacheFile: z.cacheFile });
    expect(zRes.diagnostics).toEqual([]);
    expect(zRes.mutants.some((m) => m.op === "0 -> 1" && m.range.start.line === 2 && m.range.start.col === 37)).toBe(true);
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
    const { file, cacheFile } = tmpFile("witness.szigyr", src);
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
    const { file, cacheFile } = tmpFile("mut-witness.szigyr", src);
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
    const { file, cacheFile } = tmpFile("req-witness.szigyr", src);
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
    const { file, cacheFile } = tmpFile("adv-witness.szigyr", src);
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
    const { file, cacheFile } = tmpFile("gen-zero.szigyr", src);
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
    const { file, cacheFile } = tmpFile("null-witness.szigyr", src);
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
    const helperFile = join(dir, "helper.szigyr");
    const mainFile = join(dir, "main.szigyr");
    const cacheFile = join(dir, ".szigyr-cache", "mutate.json");

    writeFileSync(helperFile, `export function bump(x: i32): i32 {\n  return x + 1;\n}\n`);
    writeFileSync(
      mainFile,
      `import { bump } from "./helper.szigyr";
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
      `import { bump } from "./helper.szigyr";
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
      `import { bump } from "./helper.szigyr";
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
import { bump } from "./helper.szigyr";
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

describe("mutate: CLI (szigyr mutate)", () => {
  it("supports multiple files and human-readable text mode", () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-multi-`));
    const a = join(dir, "a.szigyr");
    const b = join(dir, "b.szigyr");
    writeFileSync(a, 'function add(x: i32, y: i32): i32 { return x + y; }\ntest("add", (t: Test) => { t.eq(add(2, 3), 5); });\n');
    writeFileSync(b, 'function neg(x: i32): i32 { return x - 1; }\ntest("neg", (t: Test) => { t.eq(neg(5), 4); });\n');
    const rJson = szigyr(dir, "mutate", "--json", "--no-cache", a, b);
    expect(rJson.code).toBe(0);
    const ls = jsonLines(rJson.out);
    const summary = ls.at(-1);
    expect(summary.kind).toBe("summary");
    expect(summary.killed + summary.survived + summary.timeout).toBe(ls.length - 1);
    expect(new Set(ls.slice(0, -1).map((m) => m.fn))).toEqual(new Set(["add", "neg"]));

    const rText = szigyr(dir, "mutate", "--no-cache", a);
    expect(rText.code).toBe(0);
    expect(rText.out).toMatch(/killed.*timeout.*survived/);
  });
  it("exits 0 with JSON lines and summary even when mutants survive, and caches in .szigyr-cache/mutate.json", () => {
    const src = `function abs(x: i32): i32 {
  if (x < 0) return -x;
  return x;
}
test("pos", (t: Test) => {
  t.eq(abs(3), 3);
});
`;
    const { dir, file } = tmpFile("abs.szigyr", src);
    const r1 = szigyr(dir, "mutate", "--json", file);
    expect(r1.code).toBe(0);
    const ls1 = jsonLines(r1.out);
    const summary1 = ls1.at(-1);
    expect(summary1).toMatchObject({ kind: "summary", cached: 0 });
    expect(summary1.survived).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".szigyr-cache", "mutate.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, ".szigyr-cache", "mutate.json"), "utf8"));
    expect(Object.keys(saved).length).toBeGreaterThan(0);

    // Second run is cached
    const r2 = szigyr(dir, "mutate", "--json", file);
    expect(r2.code).toBe(0);
    const summary2 = jsonLines(r2.out).at(-1);
    expect(summary2.cached).toBe(ls1.length - 1);

    // --no-cache bypasses cache
    const r3 = szigyr(dir, "mutate", "--json", "--no-cache", file);
    expect(r3.code).toBe(0);
    expect(jsonLines(r3.out).at(-1).cached).toBe(0);
  });

  it("exits 1 on compile errors and on baseline m=0 test failure, and 2 on CLI errors", () => {
    const { dir, file: badType } = tmpFile("bad.szigyr", "function f(x: i32): f64 { return x; }\n");
    const rCompile = szigyr(dir, "mutate", "--json", badType);
    expect(rCompile.code).toBe(1);
    expect(jsonLines(rCompile.out)[0]).toMatchObject({ code: "E2002" });

    const { dir: dir2, file: badTest } = tmpFile(
      "fail.szigyr",
      'function add(a: i32, b: i32): i32 { return a + b; }\ntest("broken", (t: Test) => { t.eq(add(1, 2), 99); });\n'
    );
    const rFail = szigyr(dir2, "mutate", "--json", badTest);
    expect(rFail.code).toBe(1);

    // CLI errors -> exit 2
    expect(szigyr(dir, "mutate").code).toBe(2);
    expect(szigyr(dir, "mutate", "/no/such/file.szigyr").code).toBe(2);
    expect(szigyr(dir, "mutate", "--backend=c", badType).code).toBe(2);
  });

  it("supports forAll(...) tests inside szigyr mutate and kills mutants with property tests", async () => {
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
    const { file, cacheFile } = tmpFile("forall-mut.szigyr", src);
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

describe("mutate: audit regression checks (#1, #2, #5, #6, #7, #9)", () => {
  it("does not emit duplicate ghost mutants in call args or f64 compound assigns", async () => {
    const src = `function id(x: i32): i32 { return x; }
function caller(a: i32, b: i32): i32 {
  return id(a + b);
}
function f64Compound(a: f64): f64 {
  let x: f64 = a;
  x += 1;
  return x;
}
test("strong", (t: Test) => {
  t.eq(id(5), 5);
  t.eq(caller(2, 3), 5);
  t.eq(f64Compound(10), 11);
});
`;
    const { file, cacheFile } = tmpFile("no-ghost.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.mutants.filter((m) => m.fn === "caller" && m.op === "+ -> -")).toHaveLength(1);
    expect(res.mutants.filter((m) => m.fn === "f64Compound" && m.op === "num -> 0")).toHaveLength(1);
    expect(res.summary.survived).toBe(0);
  });

  it("preserves loop-condition boolean literals, parenthesized switch case labels, and excludes Test-param helpers", async () => {
    const src = `function loopTrue(x: i32): { readonly v: i32 } {
  while (true) {
    if (x > 0) return { v: x };
    return { v: 0 };
  }
}
function forTrue(x: i32): { readonly v: i32 } {
  for (; true; ) {
    return x > 0 ? { v: x } : { v: 0 };
  }
}
function takeVec(v: Vec<i32>): usize { "use owned"; return v.length; }
function doOnceMove(v: Vec<i32>): usize {
  "use owned";
  let n: usize = 0;
  do {
    n = takeVec(v);
  } while (false);
  return n;
}
function parenSwitch(x: i32): i32 {
  switch (x) {
    case (1):
      return 10;
    case (-1):
      return 20;
    default:
      return 30;
  }
}
function assertHelper(t: Test, got: i32, want: i32): void {
  t.eq(got, want);
}
test("sound", (t: Test) => {
  t.eq(loopTrue(5).v, 5);
  t.eq(loopTrue(0).v, 0);
  t.eq(forTrue(3).v, 3);
  t.eq(forTrue(-1).v, 0);
  const v = Vec.create<i32>(TestAlloc.create(), 1);
  t.eq(doOnceMove(v), 0);
  assertHelper(t, parenSwitch(1), 10);
  assertHelper(t, parenSwitch(-1), 20);
  assertHelper(t, parenSwitch(0), 30);
});
`;
    const { file, cacheFile } = tmpFile("sound-loops.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    // Loop-condition boolean literals must not be mutated
    expect(res.mutants.filter((m) => ["loopTrue", "forTrue", "doOnceMove"].includes(m.fn) && (m.op === "true -> false" || m.op === "false -> true"))).toEqual([]);
    // Parenthesized case (1) (line 23) and (-1) (line 25) must not be mutated
    expect(res.mutants.filter((m) => m.fn === "parenSwitch" && (m.range.start.line === 23 || m.range.start.line === 25))).toEqual([]);
    // Helper taking `Test` (Q278) must not be a mutation target
    expect(res.mutants.filter((m) => m.fn === "assertHelper")).toEqual([]);
  });

  it("shrinks async witnesses and detects ReadonlyArray in-place element mutations", async () => {
    const src = `type Cell = { a: i32 };
async function clampAsync(x: i32): Promise<i32> {
  if (x < 0) return 0;
  return x;
}
function bumpFirst(xs: ReadonlyArray<Cell>, go: boolean): void {
  if (go && xs.length > 0) {
    xs[0].a = 99;
  }
}
test("weak", async (t: Test) => {
  t.eq(await clampAsync(5), 5);
  bumpFirst([], false);
});
`;
    const { file, cacheFile } = tmpFile("async-roarr.szigyr", src);
    const res = await mutate(file, { cache: false, cacheFile });
    expect(res.diagnostics).toEqual([]);
    const asyncM = res.mutants.find((m) => m.fn === "clampAsync" && m.op === "if -> false");
    expect(asyncM?.witness).toEqual({ args: [-1], base: 0, mutant: -1 });

    const roM = res.mutants.find((m) => m.fn === "bumpFirst" && m.op === "if -> false");
    expect(roM?.witness).not.toBeNull();
    expect(roM?.witness?.base).not.toEqual(roM?.witness?.mutant);
  });

  it("invalidates diff cache on imported type alias change, imported class method change, and test helper change", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-cache2-`));
    const cacheFile = join(dir, ".szigyr-cache", "mutate.json");
    const typesFile = join(dir, "types.szigyr");
    const clsFile = join(dir, "cls.szigyr");
    const mainFile = join(dir, "main.szigyr");

    writeFileSync(typesFile, `export type N = i32;\n`);
    writeFileSync(clsFile, `export class Box { readonly v: i32; constructor(v: i32) { this.v = v; } scale(): i32 { return this.v; } }\n`);
    const mainSrc = (helperArgs: string) => `import { N } from "./types.szigyr";
import { Box } from "./cls.szigyr";
function helper(t: Test): void {
  t.eq(add(${helperArgs}), 1);
}
function add(a: N, b: N): N {
  return a + b;
}
function useBox(b: Box, x: i32): i32 {
  return x + b.scale();
}
test("add", (t: Test) => { helper(t); });
test("box", (t: Test) => { const b = new Box(0); t.ok(useBox(b, 5) >= 5); });
`;
    writeFileSync(mainFile, mainSrc("1, 0"));

    const r1 = await mutate(mainFile, { cache: true, cacheFile });
    expect(r1.summary.cached).toBe(0);
    expect(r1.mutants.find((m) => m.fn === "add" && m.op === "+ -> -")!.status).toBe("survived");
    expect(r1.mutants.find((m) => m.fn === "useBox" && m.op === "+ -> -")!.status).toBe("survived");

    // 1. Strengthen test helper -> only `add` cache invalidates and `+ -> -` becomes killed!
    writeFileSync(mainFile, mainSrc("0, 1"));
    const r2 = await mutate(mainFile, { cache: true, cacheFile });
    const addM2 = r2.mutants.find((m) => m.fn === "add" && m.op === "+ -> -")!;
    expect(addM2.cached).toBe(false);
    expect(addM2.status).toBe("killed");
    expect(r2.mutants.find((m) => m.fn === "useBox")!.cached).toBe(true);

    // 2. Edit imported class method -> `useBox` cache invalidates and `+ -> -` becomes killed!
    writeFileSync(clsFile, `export class Box { readonly v: i32; constructor(v: i32) { this.v = v; } scale(): i32 { return 10; } }\n`);
    const r3 = await mutate(mainFile, { cache: true, cacheFile });
    const boxM3 = r3.mutants.find((m) => m.fn === "useBox" && m.op === "+ -> -")!;
    expect(boxM3.cached).toBe(false);
    expect(boxM3.status).toBe("killed");
    expect(r3.mutants.find((m) => m.fn === "add")!.cached).toBe(true);

    // 3. Edit imported type alias -> `add` cache invalidates (`useBox` stays cached)
    writeFileSync(typesFile, `export type N = f64;\n`);
    const r4 = await mutate(mainFile, { cache: true, cacheFile });
    expect(r4.mutants.filter((m) => m.fn === "add").every((m) => !m.cached)).toBe(true);
    expect(r4.mutants.filter((m) => m.fn === "useBox").every((m) => m.cached)).toBe(true);
  });

  it("reports targets, skipped reasons, and suppresses // szigyr-equivalent: lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-skip-equiv-`));
    const f = join(dir, "main.szigyr");
    writeFileSync(f, `function helper(t: Test): void {
  t.eq(calc(2), 4);
}
function unsafeFn(): i32 {
  "use owned";
  "use unsafe";
  return 1;
}
function ffiFn(ffi: Ffi): void {}
function clockFn(c: Clock, x: i32): f64 {
  return c.nowMs() + f64(x + 1);
}
function calc(x: i32): i32 {
  if (x >= 0) { // szigyr-equivalent: boundary x === 0 gives same 0
    return x + x;
  }
  return 0;
}
test("calc", (t: Test) => {
  helper(t);
  const fc = FakeClock.create(10);
  t.eq(clockFn(fc, 2), 13);
});
`);
    const r = await mutate(f, { cache: false });
    expect(r.summary.targets).toBe(2);
    expect(r.summary.skipped).toEqual([
      { fn: "helper", reason: "test-helper" },
      { fn: "unsafeFn", reason: "unsafe" },
      { fn: "ffiFn", reason: "not-mutatable" },
    ]);
    expect(r.mutants.some((m) => m.fn === "clockFn")).toBe(true);
    expect(r.mutants.every((m) => m.range.start.line !== 14)).toBe(true);
  });

  it("mutates 2-param isolate workers via FakeSpawn and kills send-deletion deadlocks quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-fakespawn-mut-`));
    const f = join(dir, "main.szigyr");
    writeFileSync(f, `async function addWorker(port: Port<Vec<u8>, u8>, alloc: Alloc): Promise<void> {
  const seed = await port.recv();
  if (seed === null || seed === 0) return;
  const out = Vec.create<u8>(alloc, 0); // szigyr-equivalent: initial capacity hint does not change length or values
  out.push(seed + 10);
  port.send(out);
}
async function runWorker(sp: Spawn, seed: u8): Promise<u8> {
  const port = sp.isolate(addWorker);
  port.send(seed);
  const reply = await port.recv();
  if (reply === null) return 255;
  return reply[0];
}
test("fake spawn worker", async (t: Test) => {
  const fsp = FakeSpawn.create();
  t.eq(await runWorker(fsp, 5), u8(15));
  t.eq(await runWorker(fsp, 0), u8(255));
  const idle = fsp.isolate(addWorker);
  idle.close();
  const empty = await idle.recv();
  t.ok(empty === null);
});
`);
    const t0 = Date.now();
    const r = await mutate(f, { cache: false });
    const elapsed = Date.now() - t0;
    expect(r.diagnostics).toEqual([]);
    expect(r.baselineFailure).toBeNull();
    expect(r.mutants.some((m) => m.fn === "addWorker" && m.op === "delete-stmt" && m.status === "killed")).toBe(true);
    expect(r.summary.survived).toBe(0);
    expect(elapsed).toBeLessThan(10000);
  });

  it("supports op-scoped // szigyr-equivalent[op1, op2]: reason while keeping other mutants on the same line", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-equiv-ops-`));
    const f = join(dir, "main.szigyr");
    writeFileSync(f, `function oneOp(x: i32): i32 {
  if (x >= 10) return 99; // szigyr-equivalent[>= -> >]: x === 10 never happens in callers
  return x;
}
function twoOps(x: i32): i32 {
  if (x >= 0) return 42; // szigyr-equivalent[>= -> >, num -> 0]: x === 0 unreachable and 42 unchecked
  return x;
}
function prevPlusInline(x: i32): i32 {
  // szigyr-equivalent[if -> false]: test previous-line filter
  if (x >= 0) return x + 1; // szigyr-equivalent[>= -> >]: test inline filter union
  return -x;
}
function emptyOrMismatch(x: i32): i32 {
  // szigyr-equivalent[]: ignored empty filter
  if (x >= 5) return 99; // szigyr-equivalent[nonexistent]: mismatched op does not suppress
  return x;
}
test("ops", (t: Test) => {
  t.eq(oneOp(5), 5);
  t.eq(oneOp(11), 99);
  t.eq(twoOps(-1), -1);
  t.eq(twoOps(1), 42);
  t.eq(prevPlusInline(-3), 3);
  t.eq(prevPlusInline(2), 3);
  t.eq(emptyOrMismatch(1), 1);
  t.eq(emptyOrMismatch(6), 99);
});
`);
    const r = await mutate(f, { cache: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.baselineFailure).toBeNull();
    const oneOpMutants = r.mutants.filter((m) => m.fn === "oneOp");
    expect(oneOpMutants.some((m) => m.op === ">= -> >")).toBe(false);
    expect(oneOpMutants.some((m) => m.op === "if -> false" && m.status === "killed")).toBe(true);
    expect(oneOpMutants.some((m) => m.op === "num -> 0" && m.status === "killed")).toBe(true);

    const twoOpMutants = r.mutants.filter((m) => m.fn === "twoOps");
    expect(twoOpMutants.some((m) => m.op === ">= -> >" || m.op === "num -> 0")).toBe(false);
    expect(twoOpMutants.some((m) => m.op === "if -> true" && m.status === "killed")).toBe(true);

    const unionMutants = r.mutants.filter((m) => m.fn === "prevPlusInline");
    expect(unionMutants.some((m) => m.op === "if -> false" || m.op === ">= -> >")).toBe(false);
    expect(unionMutants.some((m) => m.op === "if -> true")).toBe(true);
    expect(unionMutants.some((m) => m.op === "+ -> -")).toBe(true);

    const badMutants = r.mutants.filter((m) => m.fn === "emptyOrMismatch");
    expect(badMutants.some((m) => m.op === ">= -> >" && m.status === "survived")).toBe(true);
  });

  it("auto-skips < -> <= and > -> >= on element-access standalone clamps and literal-bound else-if clamps", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-clamp-elem-`));
    const f = join(dir, "main.szigyr");
    writeFileSync(f, `function standaloneClamp(data: Mut<Slice<u8>>, lo: u8, hi: u8): void {
  "use rt";
  for (let i: usize = 0; i < data.length; i += 1) {
    if (data[i] < lo) data[i] = lo;
    if (data[i] > hi) data[i] = hi;
  }
}
function litElseIfClamp(data: Mut<Slice<u8>>): void {
  "use rt";
  for (let i: usize = 0; i < data.length; i += 1) {
    if (data[i] < 10) {
      data[i] = 10;
    } else if (data[i] > 200) {
      data[i] = 200;
    }
  }
}
function varElseIfClamp(x: i32, lo: i32, hi: i32): i32 {
  "use rt";
  if (x < lo) {
    x = lo;
  } else if (x > hi) {
    x = hi;
  }
  return x;
}
test("clamps", (t: Test) => {
  const a = TestAlloc.create();
  const v = Vec.create<u8>(a, 3);
  v.push(5); v.push(50); v.push(250);
  standaloneClamp(v, 10, 200);
  litElseIfClamp(v);
  t.eq(v[0], 10);
  t.eq(v[1], 50);
  t.eq(v[2], 200);
  t.eq(varElseIfClamp(0, 10, 200), 10);
  t.eq(varElseIfClamp(300, 10, 200), 200);
  t.eq(varElseIfClamp(50, 10, 200), 50);
});
`);
    const r = await mutate(f, { cache: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.baselineFailure).toBeNull();
    const standaloneClampOps = r.mutants
      .filter((m) => m.fn === "standaloneClamp" && (m.range.start.line === 4 || m.range.start.line === 5))
      .map((m) => m.op);
    expect(standaloneClampOps).not.toContain("< -> <=");
    expect(standaloneClampOps).not.toContain("> -> >=");

    const litElseIfOps = r.mutants
      .filter((m) => m.fn === "litElseIfClamp" && (m.range.start.line === 11 || m.range.start.line === 13))
      .map((m) => m.op);
    expect(litElseIfOps).not.toContain("< -> <=");
    expect(litElseIfOps).not.toContain("> -> >=");

    const varElseIfOps = r.mutants.filter((m) => m.fn === "varElseIfClamp").map((m) => m.op);
    expect(varElseIfOps).toContain("< -> <=");
  });

  it("deduplicates imported modules under mutate --all across multiple CLI file arguments", () => {
    const { dir, file: lib } = tmpFile("lib.szigyr", `export function inc(x: i32): i32 {
  return x + 1;
}
test("inc", (t: Test) => {
  t.eq(inc(2), 3);
});
`);
    const app = join(dir, "main.szigyr");
    writeFileSync(app, `import { inc } from "./lib.szigyr";
export function dec(x: i32): i32 {
  return inc(x) - 2;
}
test("dec", (t: Test) => {
  t.eq(dec(5), 4);
});
`);
    const one = szigyr(dir, "mutate", "--all", "--no-cache", "--fail-on-survived", "--json", app);
    const two = szigyr(dir, "mutate", "--all", "--no-cache", "--fail-on-survived", "--json", lib, app);
    const rev = szigyr(dir, "mutate", "--all", "--no-cache", "--fail-on-survived", "--json", app, lib);
    for (const res of [one, two, rev]) {
      expect(res.code, res.out + res.err).toBe(0);
    }
    const sum = (r: { out: string }) => jsonLines(r.out).find((l) => l.kind === "summary");
    expect(sum(two)).toEqual(sum(one));
    expect(sum(rev)).toEqual(sum(one));
    expect(sum(two)).toMatchObject({ targets: 2, survived: 0 });
  });
});
