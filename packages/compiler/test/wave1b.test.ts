import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyze,
  buildNode,
  check,
  CLI_NAME,
  createParser,
  mutate,
  prove,
  rtTrapSites,
  run,
  runTestFile,
  shutdownSmt,
} from "../src/index.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = `${CLI_NAME}-w1b-`): { dir: string; cacheFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return { dir, cacheFile: join(dir, ".szigyr-cache", "prove.json") };
}

function writeTmp(dir: string, rel: string, src: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  return p;
}

const parser = createParser();

afterAll(async () => {
  await shutdownSmt();
  parser.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Wave 1-B operators, callbacks, traps, prover, and mutate", () => {
  it("matches traps T001 (++/--), T007 (%/%=), and T009 (<<=/>>=/>>>=) across JS, C, and Wasm", async () => {
    const { dir } = makeTmp();
    const cases: { name: string; src: string; trap: string }[] = [
      {
        name: "t001-u8-inc",
        src: `function boom(): u8 { "use rt"; let x: u8 = 255; x++; return x; }\nexport function main(sys: System): void { boom(); }\n`,
        trap: "T001",
      },
      {
        name: "t001-i32-dec",
        src: `function boom(): i32 { "use rt"; let x: i32 = -2147483648; --x; return x; }\nexport function main(sys: System): void { boom(); }\n`,
        trap: "T001",
      },
      {
        name: "t001-i64-inc",
        src: `function boom(): i64 { "use rt"; let x: i64 = 9223372036854775807; x++; return x; }\nexport function main(sys: System): void { boom(); }\n`,
        trap: "T001",
      },
      {
        name: "t001-u64-dec",
        src: `function boom(): u64 { "use rt"; let x: u64 = 0; x--; return x; }\nexport function main(sys: System): void { boom(); }\n`,
        trap: "T001",
      },
      {
        name: "t007-mod-zero",
        src: `function boom(d: i32): i32 { "use rt"; return 10 % d; }\nexport function main(sys: System): void { boom(0); }\n`,
        trap: "T007",
      },
      {
        name: "t007-mod-assign-zero",
        src: `function boom(d: u64): u64 { "use rt"; let x: u64 = 10; x %= d; return x; }\nexport function main(sys: System): void { boom(0); }\n`,
        trap: "T007",
      },
      {
        name: "t009-shl-assign",
        src: `function boom(s: i32): i32 { "use rt"; let x: i32 = 1; x <<= s; return x; }\nexport function main(sys: System): void { boom(32); }\n`,
        trap: "T009",
      },
      {
        name: "t009-shr-assign",
        src: `function boom(s: i64): i64 { "use rt"; let x: i64 = -8; x >>= s; return x; }\nexport function main(sys: System): void { boom(-1); }\n`,
        trap: "T009",
      },
      {
        name: "t009-ushr-assign",
        src: `function boom(s: u32): u32 { "use rt"; let x: u32 = 8; x >>>= s; return x; }\nexport function main(sys: System): void { boom(32); }\n`,
        trap: "T009",
      },
    ];

    for (const c of cases) {
      const f = writeTmp(dir, `${c.name}.szigyr`, c.src);
      const a = analyze(f, parser);
      expect(a.diagnostics, c.name).toEqual([]);
      for (const backend of ["js", "c", "wasm"] as const) {
        const res = await run(f, { backend, analysis: a });
        expect(res.trap?.code, `${c.name} [${backend}]`).toBe(c.trap);
      }
    }
  });

  it("reports T001/T007/T009 in rtTrapSites for ++/--, %/%=, and <<=/>>=/>>>=", () => {
    const { dir } = makeTmp();
    const f = writeTmp(dir, "sites.szigyr", [
      `export function f(x: i32, d: i32, s: i32, u: u32, us: u32): i32 {`,
      `  "use rt";`,
      `  let a: i32 = x;`,
      `  a++;`,
      `  --a;`,
      `  const r = a % d;`,
      `  a %= d;`,
      `  a <<= s;`,
      `  a >>= s;`,
      `  let lu: u32 = u;`,
      `  lu >>>= us;`,
      `  return r + a + i32(lu);`,
      `}`,
      ``,
    ].join("\n"));

    const sites = rtTrapSites(f);
    expect(sites.f).toEqual([
      { code: "T001", line: 4, col: 3 },
      { code: "T001", line: 5, col: 3 },
      { code: "T007", line: 6, col: 15 },
      { code: "T007", line: 7, col: 5 },
      { code: "T009", line: 8, col: 5 },
      { code: "T009", line: 9, col: 5 },
      { code: "T009", line: 11, col: 6 },
      { code: "T001", line: 12, col: 12 },
      { code: "T001", line: 12, col: 16 },
      { code: "T003", line: 12, col: 18 },
    ]);
  });

  it("proves counting for-i++, %, %=, <<=, and inferred-param ensures in SMT & caches PostfixUnaryExpression", async () => {
    const { dir, cacheFile } = makeTmp();
    const okFile = writeTmp(dir, "proved.szigyr", [
      `function sumVec(v: Ref<Slice<i32>>): usize {`,
      `  "use rt";`,
      `  requires(v.length <= 100);`,
      `  let count: usize = 0;`,
      `  for (let i: usize = 0; i < v.length; i++) {`,
      `    invariant(count <= i);`,
      `    if (v[i] > 0) count++;`,
      `  }`,
      `  return count;`,
      `}`,
      `function modAndShift(x: i32, d: i32, n: i32): i32 {`,
      `  "use rt";`,
      `  requires(d !== 0 && n >= 0 && n < 32);`,
      `  ensures((r) => r >= -2147483648);`,
      `  let a: i32 = x % d;`,
      `  let b: i32 = a;`,
      `  b %= d;`,
      `  b <<= n;`,
      `  return b;`,
      `}`,
      `function loopIdx(v: Ref<Slice<i32>>): usize {`,
      `  "use rt";`,
      `  let sum: usize = 0;`,
      `  for (let i: usize = 0; i < v.length; i++) {`,
      `    if (v[i] < 0) sum = i;`,
      `  }`,
      `  return sum;`,
      `}`,
      `function minRem(a: i32, d: i32): i32 {`,
      `  "use rt";`,
      `  requires(d !== 0);`,
      `  return a % d;`,
      `}`,
      `export function main(sys: System): void {`,
      `  const v = Vec.create<i32>(sys.alloc, 2);`,
      `  v.push(1);`,
      `  v.push(-2);`,
      `  sys.log.info(\`\${sumVec(v)},\${loopIdx(v)},\${modAndShift(-17, 5, 1)},\${minRem(-2147483648, -1)}\`);`,
      `}`,
      ``,
    ].join("\n"));

    const a1 = analyze(okFile, parser);
    expect(a1.diagnostics).toEqual([]);
    const pr1 = await prove(okFile, { analysis: a1, cacheFile, parser });
    expect(pr1.diagnostics).toEqual([]);
    expect(pr1.summary.failed).toBe(0);
    expect(pr1.summary.unknown).toBe(0);
    expect(pr1.functions.find((f) => f.fn === "sumVec")?.remainingRtTrapSites?.filter((s) => s.code !== "T004")).toEqual([]);
    expect(pr1.functions.find((f) => f.fn === "modAndShift")?.remainingRtTrapSites?.filter((s) => s.code !== "T004")).toEqual([]);
    expect(pr1.functions.find((f) => f.fn === "loopIdx")?.remainingRtTrapSites).toEqual([]);
    expect(pr1.functions.find((f) => f.fn === "minRem")?.remainingRtTrapSites?.filter((s) => s.code !== "T004")).toEqual([]);

    // Cached second run still hydrates PostfixUnaryExpression anchor into `proved.anchors` and release C/Wasm keeps MIN % -1 === 0!
    const a2 = analyze(okFile, parser);
    const pr2 = await prove(okFile, { analysis: a2, cacheFile, parser });
    expect(pr2.functions.every((f) => f.cached)).toBe(true);
    for (const backend of ["c", "wasm"] as const) {
      const outDir = join(dir, `rel-${backend}`);
      const b = buildNode(okFile, { outDir, backend, analysis: a2, parser, proved: pr2.proved });
      expect(b.diagnostics).toEqual([]);
      expect(b.provedEliminated).toBeGreaterThan(0);
      const app = await import(pathToFileURL(join(outDir, "app.js")).href) as {
        load: () => Promise<{ run: () => Promise<{ trap: unknown; stdout: string }>; stop: () => Promise<void> }>;
      };
      const loaded = await app.load();
      try {
        const res = await loaded.run();
        expect(res.trap).toBeNull();
        expect(res.stdout).toBe("1,1,-4,0\n");
      } finally {
        await loaded.stop();
      }
    }

    // Soundness: loops containing `x++` or `x &= m` havoc `x` in `collectModSet` rather than keeping pre-loop values.
    const havocFile = writeTmp(dir, "havoc.szigyr", [
      `export function badInc(n: i32): i32 {`,
      `  "use rt";`,
      `  requires(n >= 0 && n <= 5);`,
      `  ensures((r) => r === 0);`,
      `  let x: i32 = 0;`,
      `  let i: i32 = 0;`,
      `  while (i < n) { x++; i++; }`,
      `  return x;`,
      `}`,
      `export function badBit(n: i32): i32 {`,
      `  "use rt";`,
      `  requires(n >= 0 && n <= 5);`,
      `  ensures((r) => r === 7);`,
      `  let x: i32 = 7;`,
      `  let i: i32 = 0;`,
      `  while (i < n) { x &= 1; i++; }`,
      `  return x;`,
      `}`,
      ``,
    ].join("\n"));
    const hp = await prove(havocFile, { cache: false, parser });
    expect(hp.functions.find((f) => f.fn === "badInc")?.obligations.some((o) => o.kind === "T005" && o.status !== "proved")).toBe(true);
    expect(hp.functions.find((f) => f.fn === "badBit")?.obligations.some((o) => o.kind === "T005" && o.status !== "proved")).toBe(true);
  });

  it("generates delete-stmt mutants for ++/--, %=, &= and does not mutate string + string", async () => {
    const { dir } = makeTmp();
    const f = writeTmp(dir, "mut.szigyr", [
      `function step(n: i32): i32 {`,
      `  let count: i32 = n;`,
      `  count++;`,
      `  count %= 5;`,
      `  count &= 3;`,
      `  return count;`,
      `}`,
      `function greet(a: string, b: string): string {`,
      `  return a + b;`,
      `}`,
      `test("t", (t) => {`,
      `  t.eq(step(7), 3);`,
      `  t.eq(greet("hi", "!"), "hi!");`,
      `});`,
      ``,
    ].join("\n"));

    const tr = await runTestFile(f);
    expect(tr.diagnostics).toEqual([]);
    expect(tr.results.every((r) => r.ok)).toBe(true);

    const mr = await mutate(f, { cache: false });
    expect(mr.diagnostics).toEqual([]);
    expect(mr.baselineFailure).toBeNull();
    const stepDel = mr.mutants.filter((m) => m.fn === "step" && m.op === "delete-stmt");
    expect(stepDel.length).toBe(3);
    expect(mr.mutants.filter((m) => m.fn === "greet")).toEqual([]);
  });

  it("supports inferred test(t => ...) while preserving E2006 where context is absent or incomplete", async () => {
    const { dir } = makeTmp();
    const okTest = writeTmp(dir, "ok_test.szigyr", [
      `test("no annotation on t", (t) => {`,
      `  t.eq(1 + 2, 3);`,
      `});`,
      ``,
    ].join("\n"));
    const tr = await runTestFile(okTest);
    expect(tr.diagnostics).toEqual([]);
    expect(tr.results).toHaveLength(1);
    expect(tr.results[0]!.ok).toBe(true);

    const badCases = [
      `test("forAll", (t) => { forAll((x) => {}); });\n`,
      `export function f(): void { const g = (x) => x; g; }\n`,
      `function id<T>(x: T): T { return x; }\nexport function f(): void { id((x) => x); }\n`,
      `export function f(js: Js): JsRef { return js.callback((r) => {}); }\n`,
      `export function f(xs: i32[]): i32[] { return xs.map((x, i, extra) => x); }\n`,
    ];
    for (const src of badCases) {
      const bf = writeTmp(dir, `bad_${Math.random().toString(36).slice(2)}.szigyr`, src);
      expect(check(bf).some((d) => d.code === "E2006"), src).toBe(true);
    }
  });
});
