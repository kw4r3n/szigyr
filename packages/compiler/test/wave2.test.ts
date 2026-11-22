import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  check,
  CLI_NAME,
  deterministicFunctions,
  mutate,
  queryFile,
  run,
  runTestFile,
} from "../src/index.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = `${CLI_NAME}-w2-`): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeTmp(dir: string, rel: string, src: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  return p;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Wave 2: immutable tuples, Map.entries(), and stateless RegExp", () => {
  it("supports tuple types, ReadonlyArray subtyping, indexing, destructuring, cast, forAll, and queryFile", async () => {
    const dir = makeTmp();
    const f = writeTmp(
      dir,
      "tuples.szigyr",
      [
        `export type Pair<A, B> = [A, B];`,
        `export function makePair(n: i32, s: string): readonly [num: i32, label: string] {`,
        `  return [n, s];`,
        `}`,
        `export function useTuples(xs: readonly i32[]): i32 {`,
        `  let s: i32 = 0;`,
        `  for (const x of xs) s += x;`,
        `  return s;`,
        `}`,
        `export function takeFirst(p: [i32, string, boolean]): i32 {`,
        `  const [first] = p;`,
        `  return first;`,
        `}`,
        `export function dynHomog(p: [i32, i32, i32], i: usize): i32 {`,
        `  return p[i];`,
        `}`,
        `export function tupleSummary(): string {`,
        `  const p = makePair(4, "four");`,
        `  let [a, b] = p;`,
        `  a += 3;`,
        `  const [, onlyB] = p;`,
        `  const tri: [i32, i32, i32] = [1, 2, 3];`,
        `  const opt: [i32, string] | null = [5, "ok"];`,
        `  const optLen = opt !== null ? opt.length : usize(0);`,
        `  return \`\${a}:\${b}:\${onlyB}:\${useTuples(tri)}:\${takeFirst([8, "x", true])}:\${dynHomog(tri, 1)}:\${optLen}\`;`,
        `}`,
        `test("tuple forAll and eq", (t: Test) => {`,
        `  t.eq(tupleSummary(), "7:four:four:6:8:2:2");`,
        `  forAll((p: [i32, boolean]): boolean => {`,
        `    requires(!p[1]);`,
        `    return p[0] <= 10;`,
        `  });`,
        `});`,
        `export function main(sys: System): void {`,
        `  sys.log.info(tupleSummary());`,
        `}`,
        ``,
      ].join("\n"),
    );

    const q = queryFile(f);
    expect(q.diagnostics).toEqual([]);
    const useFn = q.symbols.find((s) => s.name === "useTuples");
    expect(useFn?.caps).toBeUndefined();
    expect(deterministicFunctions(f).useTuples).toBe(true);
    expect(deterministicFunctions(f).makePair).toBe(true);

    const r = await run(f);
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("7:four:four:6:8:2:2\n");

    const tr = await runTestFile(f);
    expect(tr.diagnostics).toEqual([]);
    expect(tr.results).toHaveLength(1);
    expect(tr.results[0]!.ok).toBe(false);
    expect(tr.results[0]!.detail?.kind).toBe("forAll");
    expect(tr.results[0]!.detail?.counterexample).toEqual([[11, false]]);

    const trapSrc = writeTmp(
      dir,
      "trap_oob.szigyr",
      [
        `function getAt(t: [i32, i32], i: usize): i32 { return t[i]; }`,
        `export function main(sys: System): void { sys.log.info(String.fromCodePoint(u32(getAt([1, 2], 5)))); }`,
        ``,
      ].join("\n"),
    );
    const trapRun = await run(trapSrc);
    expect(trapRun.diagnostics).toEqual([]);
    expect(trapRun.trap?.code).toBe("T002");
  });

  it("rejects invalid tuple constructs, mutations, alias owned leaks, and module-level array destructuring", () => {
    const dir = makeTmp();
    const cases: [string, string, string][] = [
      ["tuple to mutable Array", `export function f(p: [i32, i32]): Array<i32> { return p; }`, "E2002"],
      ["float literal tuple index", `export function f(p: [i32, i32]): i32 { return p[1.5]; }`, "E2008"],
      ["non-tuple destructuring", `export function f(xs: Array<i32>): i32 { const [a] = xs; return a; }`, "E2002"],
      ["let tuple element capture disables unsound narrowing", `export function f(p: [string | null, i32]): usize {\n  let [s, _] = p;\n  const clear = (): void => { s = null; };\n  if (s !== null) { clear(); return s.length; }\n  return 0;\n}`, "E2002"],
      ["generic alias holding owned via tuple", `type Pair<T> = [T, T];\nfunction f(alloc: Alloc): Pair<Vec<f32>> { return [Vec.create<f32>(alloc, 1), Vec.create<f32>(alloc, 1)]; }`, "E3007"],
      ["module const tuple holding mutable Array", `const BAD: [string, i32[]] = ["a", [1]];`, "E5002"],
      ["for-of destructuring over tuple array literal", `export function f(xs: [i32, i32]): i32 { for (const [a, b] of [xs]) {} return 0; }`, ""],
    ];

    for (const [label, src, code] of cases) {
      const f = writeTmp(dir, `${label.replace(/\W+/g, "_")}.szigyr`, `${src}\n`);
      const ds = check(f);
      if (code === "") expect(ds, label).toEqual([]);
      else expect(ds.some((d) => d.code === code), `${label}: ${JSON.stringify(ds)}`).toBe(true);
    }

    const negIdx = writeTmp(dir, "neg_idx.szigyr", `export function f(p: [i32, i32]): i32 { return p[-1]; }\n`);
    const negDs = check(negIdx);
    expect(negDs).toHaveLength(1);
    expect(negDs[0]!.code).toBe("E2008");
  });

  it("supports Map.entries() iteration and rejects non-iterated entries() values", async () => {
    const dir = makeTmp();
    const okFile = writeTmp(
      dir,
      "entries_ok.szigyr",
      [
        `export function main(sys: System): void {`,
        `  const m = new Map<string, i32>();`,
        `  m.set("x", 10).set("y", 20);`,
        `  let sum: i32 = 0;`,
        `  for (const [k, v] of m.entries()) {`,
        `    if (k === "x") sum += v;`,
        `    else sum += v * 2;`,
        `  }`,
        `  sys.log.info(\`\${sum}\`);`,
        `}`,
        ``,
      ].join("\n"),
    );
    const r = await run(okFile);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("50\n");

    const badUse = writeTmp(dir, "entries_bad.szigyr", `export function f(m: Map<string, i32>): void { const it = m.entries(); }\n`);
    expect(check(badUse).some((d) => d.code === "E2002")).toBe(true);
  });

  it("supports stateless RegExp literals and RegExp.compile and rejects unsafe/stateful forms", async () => {
    const dir = makeTmp();
    const okFile = writeTmp(
      dir,
      "regex_ok.szigyr",
      [
        `const WORD: RegExp = /([a-z]+)(\\d*)/imu;`,
        `export function classify(s: string, re: RegExp): string {`,
        `  return re.test(s) ? "yes" : "no";`,
        `}`,
        `test("stateless regexp behaviors", (t: Test) => {`,
        `  t.eq(classify("abc1", WORD), "yes");`,
        `  t.eq(classify("abc2", WORD), "yes");`,
        `  t.eq(WORD.source, "([a-z]+)(\\\\d*)");`,
        `  t.eq(WORD.flags, "imu");`,
        `  const r = /(ab)+/s;`,
        `  t.ok(r.test("a\\nbabab"));`,
        `  const c = RegExp.compile("foo-(\\\\d+)", "i");`,
        `  t.eq(c.kind, "ok");`,
        `  if (c.kind === "ok") {`,
        `    const m = c.value.exec("zz FOO-77 yy FOO-88");`,
        `    t.ok(m !== null);`,
        `    if (m !== null) { t.eq(m.text, "FOO-77"); t.eq(m.index, usize(3)); t.eq(m.groups, ["77"]); }`,
        `    t.eq(c.value.findAll("FOO-1 FOO-2").map((x) => x.text), ["FOO-1", "FOO-2"]);`,
        `    t.eq(c.value.replace("FOO-1 FOO-2", "$1"), "1 FOO-2");`,
        `    t.eq(c.value.replaceAll("FOO-1 FOO-2", "$1"), "1 2");`,
        `  }`,
        `  t.eq(RegExp.compile("a", "y").kind, "err");`,
        `  t.eq(RegExp.compile("a", "ii").kind, "err");`,
        `  t.eq(RegExp.compile("(").kind, "err");`,
        `});`,
        ``,
      ].join("\n"),
    );

    expect(deterministicFunctions(okFile).classify).toBe(true);
    const tr = await runTestFile(okFile);
    expect(tr.diagnostics).toEqual([]);
    expect(tr.results.map((x) => x.ok)).toEqual([true]);

    const badCases: [string, string, string][] = [
      ["flag y", `export function f(): void { const r = /a/y; }`, "E1000"],
      ["flag ii duplicate", `export function f(): void { const r = /a/ii; }`, "E1000"],
      ["invalid syntax", `export function f(): void { const r = /(/; }`, "E1000"],
      ["new RegExp", `export function f(): void { const r = new RegExp("a"); }`, "E2002"],
      ["RegExp type in strict", `function f(r: RegExp): void { "use owned"; }`, "E4002"],
      ["RegExp.compile in strict", `function f(): void { "use owned"; const r = RegExp.compile("a"); }`, "E4001"],
    ];
    for (const [label, src, code] of badCases) {
      const f = writeTmp(dir, `re_${label.replace(/\W+/g, "_")}.szigyr`, `${src}\n`);
      expect(check(f).some((d) => d.code === code), label).toBe(true);
    }
  });

  it("handles mutation testing on pure functions taking immutable tuples", async () => {
    const dir = makeTmp();
    const f = writeTmp(
      dir,
      "mut_tup.szigyr",
      [
        `export function addPair(p: [i32, i32]): i32 {`,
        `  return p[0] + p[1];`,
        `}`,
        `test("addPair", (t: Test) => {`,
        `  t.eq(addPair([2, 3]), 5);`,
        `});`,
        ``,
      ].join("\n"),
    );
    const m = await mutate(f, { cacheFile: join(dir, ".szigyr-cache", "mutate.json") });
    expect(m.diagnostics).toEqual([]);
    expect(m.summary.survived).toBe(0);
    expect(m.summary.killed).toBeGreaterThan(0);
  });
});
