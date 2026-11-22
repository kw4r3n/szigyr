import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_NAME, check, prove, run, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const tempDirs: string[] = [];
function makeTmp(prefix = "switch-const"): string {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("literal-constant switch case labels", () => {
  it("supports module, local, chained, parenthesized, and imported const case labels across js/c/wasm, prove, and mutate", async () => {
    const dir = makeTmp("pos");
    const tagsFile = join(dir, "tags.szigyr");
    writeFileSync(tagsFile, `
export const NS_ONE: u8 = 1;
export const NS_TWO: u8 = 2;
export const NS_OK: "ok" = "ok";
export const NS_ERR: "err" = "err";
`);

    const mainFile = join(dir, "main.szigyr");
    writeFileSync(mainFile, `
import { NS_ONE, NS_OK } from "./tags.szigyr";
import * as Tags from "./tags.szigyr";

const TAG_ZERO: u8 = 0;
const TAG_NEG: i32 = -5;
const TAG_POS: i32 = 7;
const TAG_U64: u64 = 1099511627776;
const TAG_F32: f32 = 1.5;
const FLAG_TRUE: boolean = true;
const FLAG_FALSE: boolean = false;
const K_ERR: "err" = "err";

type Outcome =
  | { readonly kind: "ok"; readonly val: i32 }
  | { readonly kind: "err"; readonly code: i32 };

function evalU8(x: u8): i32 {
  "use rt";
  const LOCAL_THREE: u8 = 3;
  const CHAINED: u8 = NS_ONE;
  switch (x) {
    case TAG_ZERO: return 10;
    case CHAINED: return 20;
    case (Tags.NS_TWO): return 30;
    case LOCAL_THREE: return 40;
    default: return 99;
  }
}

function evalI32(x: i32): i32 {
  "use rt";
  const LOCAL_NEG: i32 = TAG_NEG;
  switch (x) {
    case LOCAL_NEG: return -50;
    case TAG_POS: return 70;
    default: return 0;
  }
}

function evalU64(x: u64): i32 {
  "use rt";
  switch (x) {
    case TAG_U64: return 64;
    default: return 1;
  }
}

function evalF32(x: f32): i32 {
  "use rt";
  switch (x) {
    case TAG_F32: return 15;
    case 0.5: return 5;
    default: return 0;
  }
}

function evalBool(b: boolean): i32 {
  "use rt";
  switch (b) {
    case FLAG_TRUE: return 1;
    case FLAG_FALSE: return 0;
  }
}

function evalUnion(r: Outcome): i32 {
  "use rt";
  const LOCAL_ERR: "err" = Tags.NS_ERR;
  switch (r.kind) {
    case NS_OK: return wrapAdd(r.val, 1);
    case LOCAL_ERR: return wrapSub(0, r.code);
  }
}

function evalUnionDefault(r: Outcome): i32 {
  "use rt";
  switch (r.kind) {
    case NS_OK: return r.val;
    case K_ERR: return r.code;
  }
}

export function main(sys: System): void {
  const sum = evalU8(0) + evalU8(1) + evalU8(2) + evalU8(3) + evalU8(9);
  const neg = evalI32(-5) + evalI32(7) + evalI32(2);
  const u64v = evalU64(1099511627776) + evalU64(0);
  const f32v = evalF32(f32(1.5)) + evalF32(f32(0.5)) + evalF32(f32(2));
  const bv = evalBool(true) * 10 + evalBool(false);
  const uv = evalUnion({ kind: "ok", val: 40 }) + evalUnion({ kind: "err", code: 3 });
  const dv = evalUnionDefault({ kind: "ok", val: 8 }) + evalUnionDefault({ kind: "err", code: 2 });
  sys.log.info(\`res=\${sum},\${neg},\${u64v},\${f32v},\${bv},\${uv},\${dv}\`);
}

test("constant switch labels match expected outcomes", (t: Test) => {
  t.eq(evalU8(0), 10);
  t.eq(evalU8(1), 20);
  t.eq(evalU8(2), 30);
  t.eq(evalU8(3), 40);
  t.eq(evalU8(4), 99);
  t.eq(evalI32(-5), -50);
  t.eq(evalI32(7), 70);
  t.eq(evalI32(0), 0);
  t.eq(evalU64(1099511627776), 64);
  t.eq(evalU64(5), 1);
  t.eq(evalF32(f32(1.5)), 15);
  t.eq(evalF32(f32(0.5)), 5);
  t.eq(evalF32(f32(3.0)), 0);
  t.eq(evalBool(true), 1);
  t.eq(evalBool(false), 0);
  t.eq(evalUnion({ kind: "ok", val: 40 }), 41);
  t.eq(evalUnion({ kind: "err", code: 3 }), -3);
  t.eq(evalUnionDefault({ kind: "ok", val: 8 }), 8);
  t.eq(evalUnionDefault({ kind: "err", code: 2 }), 2);
});
`);

    expect(check(mainFile)).toEqual([]);

    for (const backend of ["js", "c", "wasm"] as Backend[]) {
      const rr = await run(mainFile, { backend });
      expect(rr.diagnostics, `${backend} run diagnostics`).toEqual([]);
      expect(rr.trap, `${backend} run trap`).toBeNull();
      expect(rr.stdout.trim()).toBe("res=199,20,65,20,10,38,10");

      const tr = await runTestFile(mainFile, { backend });
      expect(tr.diagnostics, `${backend} test diagnostics`).toEqual([]);
      expect(tr.results.every((x) => x.ok)).toBe(true);
    }

    const pr = await prove(mainFile, { all: true, cache: false });
    expect(pr.diagnostics).toEqual([]);
    expect(pr.summary.failed).toBe(0);
    expect(pr.summary.unknown).toBe(0);
    expect(pr.summary.timeout).toBe(0);

    const mut = await mutateFile(mainFile, { cache: false });
    expect(mut.diagnostics).toEqual([]);
    expect(mut.baselineFailure).toBeNull();
    expect(mut.summary.survived).toBe(0);
  }, 120_000);

  it("rejects mutable variables, non-literal/destructured consts, cconst, mismatched types, duplicates, and shadowed bindings with E2002", () => {
    const dir = makeTmp("neg");
    const negFile = join(dir, "neg.szigyr");
    writeFileSync(negFile, `
declare module "c:zlib:zlib.h" {
  const Z_OK: i32;
}
import { Z_OK } from "c:zlib:zlib.h";

const A: u8 = 1;
const B: u8 = 0x01;
const F_NUM: f64 = 1;
const PLAIN_STR: string = "ok";
const OUTER_CONST: u8 = 2;

type R = { readonly kind: "ok"; readonly v: i32 } | { readonly kind: "err"; readonly code: i32 };

function helper(): i32 {
  return 5;
}

function badCases(p: u8, r: R): i32 {
  let m: u8 = 1;
  const nonLit: i32 = helper();
  const { a }: { readonly a: u8 } = { a: 1 };
  let x: i32 = 0;

  switch (p) {
    case m: x = 1; break;
    case p: x = 2; break;
    case a: x = 3; break;
    case F_NUM: x = 4; break;
    default: x = 5; break;
  }

  switch (x) {
    case nonLit: return 1;
    default: return 0;
  }
}

function badDuplicatesAndShadow(p: u8, r: R): i32 {
  let OUTER_CONST: u8 = 3;
  switch (p) {
    case 1: return 1;
    case A: return 2;
    case B: return 3;
    case OUTER_CONST: return 4;
    default: return 0;
  }
}

function badCConst(x: i32): i32 {
  "use unsafe";
  switch (x) {
    case Z_OK: return 1;
    default: return 0;
  }
}

function badUnionType(r: R): i32 {
  switch (r.kind) {
    case PLAIN_STR: return 1;
    default: return 0;
  }
}
`);

    const diags = check(negFile);
    const e2002 = diags.filter((d) => d.code === "E2002").map((d) => `${d.range.start.line}:${d.message}`);
    expect(e2002).toContain("26:case label must be a literal or literal constant of the discriminant type"); // let m
    expect(e2002).toContain("27:case label must be a literal or literal constant of the discriminant type"); // param p
    expect(e2002).toContain("28:case label must be a literal or literal constant of the discriminant type"); // destructured a
    expect(e2002).toContain("29:case label must be a literal or literal constant of the discriminant type"); // f64 const on u8 switch
    expect(e2002).toContain("34:case label must be a literal or literal constant of the discriminant type"); // nonLit const
    expect(e2002).toContain("43:duplicate case label"); // A === 1
    expect(e2002).toContain("44:duplicate case label"); // B === 0x01 === 1
    expect(e2002).toContain("45:case label must be a literal or literal constant of the discriminant type"); // local let shadowing OUTER_CONST
    expect(e2002).toContain("53:case label must be a literal or literal constant of the discriminant type"); // cconst Z_OK
    expect(e2002).toContain("60:case label must be a literal or literal constant of the discriminant type"); // string vs "ok"|"err"
  });
});
