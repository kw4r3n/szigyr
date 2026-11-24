import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, runTestFile } from "../src/index.ts";
import { main as cliMain } from "../src/cli.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-forall-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return join(dir, "main.szigyr");
}

describe("forAll property testing (§16.1)", () => {
  it("runs 100 valid trials and shrinks counterexamples for inline arrows and named fns", async () => {
    const main = project({
      "main.szigyr": `
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
  fuzzContracts(absVal);
  fuzzContracts(isPositive); // fuzzContracts checks contracts/traps only; return value is ignored
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
      "main.szigyr": `
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
      "lib.szigyr": `
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
      "main.szigyr": `
import { calleeWithReq, recWithReq } from "./lib.szigyr";

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
  fuzzContracts(recWithReq);
});

test("callee T004 is counterexample", (t: Test) => {
  fuzzContracts(callsCallee);
});

test("callee T004 inside requires is counterexample", (t: Test) => {
  fuzzContracts(reqCallsCallee);
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
      "main.szigyr": `
type Box = OwnedStruct<{ x: i32; buf: Vec<i32> }>;

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
      "main.szigyr": `
function badInc(x: i32): i32 {
  "use rt";
  requires(x >= 0 && x < 100);
  ensures((r: i32) => r > x + 1);
  return x + 1;
}

test("ensures fails", (t: Test) => {
  fuzzContracts(badInc);
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
      "main.szigyr": `
type Pair = { readonly a: i32; readonly b: boolean };

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
    t.ok(m.size < 1000 && s.size < 1000);
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

  it("supports generic strict/rt calls inside named fn requires on --backend=c and formats -0 counterexamples", async () => {
    const main = project({
      "main.szigyr": `
function isPos<T>(x: i32): boolean {
  "use rt";
  return x > 0;
}

function usePos(x: i32): i32 {
  "use rt";
  requires(isPos<i32>(x));
  return x;
}

test("generic rt helper in requires works on C and JS", (t: Test) => {
  fuzzContracts(usePos);
});

test("-0 counterexample formats distinctively", (t: Test) => {
  forAll((x: f64): boolean => {
    if (x === 0) {
      return 1 / x > 0;
    }
    return true;
  });
});
`,
    });
    for (const backend of ["js", "c"] as const) {
      const r = await runTestFile(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.results[0]).toMatchObject({ name: "generic rt helper in requires works on C and JS", ok: true });
      expect(r.results[1]!.ok).toBe(false);
      expect(r.results[1]!.failure).toContain('["-0"]');
    }
  });

  it("advances size across requires rejections so minimum collection length preconditions do not starve", async () => {
    const main = project({
      "main.szigyr": `
function firstThreeSum(v: Ref<Vec<f64>>): f64 {
  "use owned";
  requires(v.length >= 3);
  return v[0] + v[1] + v[2];
}

test("array min length requires", (t: Test) => {
  forAll((xs: Array<f64>): void => {
    requires(xs.length >= 3);
    t.ok(xs.length >= 3);
  });
});

test("vec min length requires", (t: Test) => {
  forAll((v: Ref<Vec<f64>>): void => {
    requires(v.length >= 3);
    t.ok(v.length >= 3);
  });
});

test("named strict fn with vec min length requires", (t: Test) => {
  fuzzContracts(firstThreeSum);
});
`,
    });
    for (const backend of ["js", "c"] as const) {
      const r = await runTestFile(main, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.results.map((x) => [x.name, x.ok])).toEqual([
        ["array min length requires", true],
        ["vec min length requires", true],
        ["named strict fn with vec min length requires", true],
      ]);
    }
  });

  it("rejects passing named functions to forAll and inline arrows to fuzzContracts with clear redirect hints", () => {
    const f1 = project({
      "main.szigyr": `
function isPositive(x: i32): boolean { return x > 0; }
function absVal(x: i32): i32 { return x < 0 ? wrapAdd(x, 0) : x; }
test("bad", (t: Test) => {
  forAll(isPositive);
  forAll(absVal);
  fuzzContracts((x: i32): boolean => x === x);
});
`,
    });
    const ds1 = check(f1);
    expect(ds1.map((d) => d.code)).toEqual(["E2002", "E2002", "E2002"]);
    expect(ds1[0]!.message).toContain("(...) => isPositive(...)");
    expect(ds1[0]!.message).toContain("fuzzContracts(isPositive)");
    expect(ds1[1]!.message).toContain("fuzzContracts(absVal)");
    expect(ds1[2]!.message).toContain("forAll((...) => ...)");

    const f2 = project({
      "main.szigyr": `
function absVal(x: i32): i32 { return x; }
fuzzContracts(absVal);
`,
    });
    expect(check(f2).map((d) => d.code)).toEqual(["E6004"]);

    const f3 = project({
      "main.szigyr": `
function absVal(x: i32): i32 { return x; }
test("bad", (t: Test) => {
  forAll((x: i32): void => {
    requires(fuzzContracts(absVal));
  });
});
`,
    });
    expect(check(f3).map((d) => d.code)).toEqual(["E6002"]);
  });
});
