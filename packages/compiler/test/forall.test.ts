import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTestFile } from "../src/index.ts";
import { main as cliMain } from "../src/cli.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sts-forall-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return join(dir, "main.ts");
}

describe("forAll property testing (§16.1)", () => {
  it("runs 100 valid trials and shrinks counterexamples for inline arrows and named fns", async () => {
    const main = project({
      "main.ts": `
function absVal(x: i32): i32 {
  "use owned";
  requires(x > -2147483648);
  return x < 0 ? -x : x;
}

function isPositive(x: i32): boolean {
  "use rt";
  return x > 0;
}

test("pass inline and named", (t: Test) => {
  forAll((x: i32): void => {
    requires(x > -2147483648);
    t.ok(absVal(x) >= 0);
  });
  forAll(absVal);
  forAll(isPositive); // named boolean returning false is NOT a failure
});

test("fail inline boolean false shrinks to 0", (t: Test) => {
  forAll((x: i32): boolean => x > 100 || x < 0);
});

test("fail t.eq shrinks", (t: Test) => {
  forAll((xs: Array<i32>): void => {
    t.ok(xs.length < 3);
  });
});
`,
    });
    for (const backend of ["js", "c"] as const) {
      const r = await runTestFile(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.results.map((x) => [x.name, x.ok])).toEqual([
        ["pass inline and named", true],
        ["fail inline boolean false shrinks to 0", false],
        ["fail t.eq shrinks", false],
      ]);
      expect(r.results[1]!.failure).toContain("[0]");
      expect(r.results[2]!.failure).toContain("[[0,0,0]]");
    }
  });

  it("fails after 1000 precondition rejections", async () => {
    const main = project({
      "main.ts": `
test("too many rejections", (t: Test) => {
  forAll((x: i32): void => {
    requires(false);
    t.ok(true);
  });
});
`,
    });
    const r = await runTestFile(main);
    expect(r.diagnostics).toEqual([]);
    expect(r.results[0]!.ok).toBe(false);
    expect(r.results[0]!.failure).toContain("1000");
  });

  it("skips ONLY f's own leading requires T004; recursive and callee T004 fail as counterexamples on both JS and C", async () => {
    const main = project({
      "lib.ts": `
export function calleeWithReq(x: i32): i32 {
  "use owned";
  requires(x > 0);
  return x;
}

export function recWithReq(x: i32): i32 {
  "use owned";
  requires(x > 0);
  if (x === 1) return recWithReq(0);
  return x;
}
`,
      "main.ts": `
import { calleeWithReq, recWithReq } from "./lib.ts";

function callsCallee(x: i32): i32 {
  "use owned";
  requires(x >= 0);
  return calleeWithReq(x);
}

function reqCallsCallee(x: i32): i32 {
  "use owned";
  requires(calleeWithReq(x) > 0);
  return x;
}

test("recursive T004 is counterexample", (t: Test) => {
  forAll(recWithReq);
});

test("callee T004 is counterexample", (t: Test) => {
  forAll(callsCallee);
});

test("callee T004 inside requires is counterexample", (t: Test) => {
  forAll(reqCallsCallee);
});
`,
    });
    for (const backend of ["js", "c"] as const) {
      const r = await runTestFile(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.results.map((x) => [x.name, x.ok])).toEqual([
        ["recursive T004 is counterexample", false],
        ["callee T004 is counterexample", false],
        ["callee T004 inside requires is counterexample", false],
      ]);
      expect(r.results[0]!.failure).toContain("[1]");
      expect(r.results[0]!.failure).toContain("T004");
      expect(r.results[1]!.failure).toContain("[0]");
      expect(r.results[1]!.failure).toContain("T004");
      expect(r.results[2]!.failure).toContain("T004");
    }
  });

  it("freshly allocates Mut<Vec> / Mut<Slice> / Mut<Struct> per trial and agrees under --backend=both", async () => {
    const main = project({
      "main.ts": `
type Box = Struct<{ x: i32; buf: Vec<i32> }>;

function pushAndSet(v: Mut<Vec<i32>>, s: Mut<Slice<i32>>, b: Mut<Box>): void {
  "use owned";
  v.push(42);
  if (s.length > 0) s[0] = 99;
  b.x = 777;
  b.buf.push(888);
}

test("mut params do not persist or alias", (t: Test) => {
  forAll((v: Vec<i32>, s: Vec<i32>, b: Box): void => {
    const origLen = v.length;
    const origSLen = s.length;
    const origBLen = b.buf.length;
    pushAndSet(v, s, b);
    t.eq(v.length, origLen + 1);
    t.eq(s.length, origSLen);
    t.eq(b.x, 777);
    t.eq(b.buf.length, origBLen + 1);
  });
});
`,
    });
    let stdout = "", stderr = "";
    const code = await cliMain(["test", "--backend=both", main], (s) => { stdout += s; }, (s) => { stderr += s; });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("1 passed, 0 failed");
  });

  it("ensures violation in named fn fails and shrinks under --backend=both", async () => {
    const main = project({
      "main.ts": `
function badInc(x: i32): i32 {
  "use rt";
  requires(x >= 0 && x < 100);
  ensures((r: i32) => r > x + 1);
  return x + 1;
}

test("ensures fails", (t: Test) => {
  forAll(badInc);
});
`,
    });
    let stdout = "";
    const code = await cliMain(["test", "--backend=both", main], (s) => { stdout += s; }, () => {});
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL ensures fails");
    expect(stdout).toContain("[0]");
    expect(stdout).toContain("T005");
  });

  it("shrinking respects leading requires and handles Vec<Struct>, Result, Map, Set, and recursive fn-expr", async () => {
    const main = project({
      "main.ts": `
type Pair = Struct<{ readonly a: i32; readonly b: boolean }>;

function sumPairs(v: Ref<Slice<Pair>>): i32 {
  "use rt";
  let s: i32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    if (v[i].b) s = wrapAdd(s, v[i].a);
  }
  return s;
}

test("shrink respects requires", (t: Test) => {
  forAll((x: i32): boolean => {
    requires(x > 0);
    return x < 10;
  });
});

test("fn-expr with requires shrinks counterexample", (t: Test) => {
  forAll(function(x: i32): void {
    requires(x >= 0);
    t.ok(x < 10);
  });
});

test("composite types and Vec<Struct> agree on JS and C", (t: Test) => {
  forAll((vp: Vec<Pair>, r: Result<i32, string>, opt: i32 | null, m: Map<string, i32>, s: Set<i32>): void => {
    const total = sumPairs(vp);
    t.ok(total === total);
    t.ok(r.kind === "ok" || r.kind === "err");
    t.ok(opt === null || opt === opt);
    t.ok(m.size >= 0 && s.size >= 0);
  });
});
`,
    });
    for (const backend of ["js", "c"] as const) {
      const r = await runTestFile(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.results.map((x) => [x.name, x.ok])).toEqual([
        ["shrink respects requires", false],
        ["fn-expr with requires shrinks counterexample", false],
        ["composite types and Vec<Struct> agree on JS and C", true],
      ]);
      expect(r.results[0]!.failure).toContain("[10]");
      expect(r.results[1]!.failure).toContain("[10]");
    }
  });
});
