import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, run } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "szigyr-float-json-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeMod(src: string, name = "main.szigyr"): string {
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
}

describe("f32 Math/Number polymorphism and static JSON.stringify rules", () => {
  it("runs f32 Math.* and Number.is* with bit-identical results across JS, C, and Wasm", async () => {
    const f = writeMod(`
function isNegZero(x: f32): boolean {
  "use rt";
  return x === 0 && (f32(1) / x) < 0;
}

function rtStep(x: f32, y: f32): { readonly sq: f32; readonly cl: f32; readonly mn: f32; readonly mx: f32; readonly ok: boolean } {
  "use rt";
  return {
    sq: Math.sqrt(y),
    cl: Math.max(-1, Math.min(1, x)),
    mn: Math.min(x, y, f32(0.25)),
    mx: Math.max(x, y, f32(3.5)),
    ok: Number.isFinite(y) && !Number.isNaN(y) && Number.isInteger(y),
  };
}

export function main(sys: System): void {
  const two: f32 = 2.0;
  const x: f32 = 1.5;
  const r = rtStep(x, two);
  const nz: f32 = -0.0;
  const hn: f32 = -0.5;
  const inf: f32 = f32(Number.POSITIVE_INFINITY);
  const nanv: f32 = f32(Number.NaN);
  const ms: f32 = Math.sqrt(two);
  const ma: f32 = Math.abs(-1.25);
  const mf: f32 = Math.floor(1.75);
  const mc: f32 = Math.ceil(1.25);
  const mt: f32 = Math.trunc(-1.75);
  const mr: f32 = Math.round(hn);
  const msg: f32 = Math.sign(-2.0);
  sys.log.info(\`\${r.sq}|\${r.cl}|\${r.mn}|\${r.mx}|\${r.ok}|\${ms}|\${ma}|\${mf}|\${mc}|\${mt}|\${isNegZero(mr)}|\${msg}|\${isNegZero(Math.min(nz, f32(0)))}|\${Number.isFinite(inf)}|\${Number.isNaN(nanv)}|\${Number.isInteger(x)}\`);
}
`, "f32_parity.szigyr");

    expect(check(f)).toEqual([]);
    const outs: string[] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const res = await run(f, { backend });
      expect(res.diagnostics, backend).toEqual([]);
      expect(res.trap, backend).toBeNull();
      outs.push(res.stdout.trim());
    }
    expect(outs[0]).toBe(outs[1]);
    expect(outs[1]).toBe(outs[2]);
    expect(outs[0]).toBe("1.4142135381698608|1|0.25|3.5|true|1.4142135381698608|1.25|1|2|-1|true|-1|true|false|true|false");
  }, 60_000);

  it("rejects mixed f32/f64 in Math.min/max, integer args with convert fix, and type arguments on Math/Number", () => {
    const fMix = writeMod(`
export function f(a: f32, b: f64): f32 {
  return Math.min(a, b);
}
`, "mix.szigyr");
    const dMix = check(fMix);
    expect(dMix.map((d) => d.code)).toEqual(["E2003"]);
    expect(dMix[0]!.data).toEqual({ left: "f32", right: "f64" });

    const fInt = writeMod(`
export function f(x: i32): void {
  const a = Math.abs(x);
  const b = Number.isFinite(x);
}
`, "int_arg.szigyr");
    const dInt = check(fInt);
    expect(dInt.map((d) => d.code)).toEqual(["E2002", "E2002"]);
    expect(dInt[0]!.fixes?.[0]?.title).toBe("convert to 'f64'");
    expect(dInt[1]!.fixes?.[0]?.title).toBe("convert to 'f64'");

    const fTArg = writeMod(`
export function f(x: f32): f32 {
  return Math.abs<f32>(x);
}
`, "targ.szigyr");
    const dTArg = check(fTArg);
    expect(dTArg.map((d) => d.code)).toEqual(["E2002"]);
    expect(dTArg[0]!.message).toContain("expects 0 type argument(s)");
  });

  it("statically rejects i64/u64 and generic Codec type params in JSON.stringify while allowing valid Codec types", () => {
    const fBad = writeMod(`
function badGeneric<T extends Codec>(x: T): string {
  return JSON.stringify<T>(x);
}
export function badConcrete(a: i64, b: u64, arr: Array<u64>, opt: i64 | null): void {
  const s1 = JSON.stringify(a);
  const s2 = JSON.stringify<u64>(b);
  const rec: { readonly id: i64 } = { id: a };
  const s3 = JSON.stringify(rec);
  const s4 = JSON.stringify(arr);
  const s5 = JSON.stringify(opt);
}
`, "json_bad.szigyr");
    const ds = check(fBad);
    expect(ds.filter((d) => d.code === "E2002" && d.data?.reason === "concrete-type-required").length).toBe(1);
    expect(ds.filter((d) => d.code === "E2002" && d.data?.reason === "json-int64").length).toBe(5);
    expect(ds.length).toBe(6);

    const fOk = writeMod(`
function enc<T extends Codec>(js: Js, x: T): JsRef {
  return js.encode<T>(x);
}
type Payload = { readonly n: i32; readonly x: f64; readonly s: string };
export function okConcrete(sys: System, n: i32, x: f64, s: string): string {
  const r = enc<i32>(sys.js, n);
  const p: Payload = { n, x, s };
  return \`\${JSON.stringify(n)}|\${JSON.stringify(x)}|\${JSON.stringify(s)}|\${JSON.stringify(p)}\`;
}
`, "json_ok_typed.szigyr");
    expect(check(fOk)).toEqual([]);
  });
});
