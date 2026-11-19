// Q191 (§12): the DetMath namespace and the bundled module in packages/std/detmath.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { check, deterministicFunctions, rtTrapSites } from "../src/index.ts";
import { DETMATH_PATH } from "../src/detmath.ts";

function run(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  for (const [n, src] of Object.entries(files)) writeFileSync(join(dir, n), src);
  return check(join(dir, "main.ts")).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`).sort();
}

it("the bundled DetMath module checks clean on its own", () => {
  expect(check(DETMATH_PATH)).toEqual([]);
});

it("every function of the bundled module is rt with an empty trap list (Q191)", () => {
  const sites = rtTrapSites(DETMATH_PATH);
  for (const name of ["sin", "cos", "tan", "atan", "exp", "log", "log10", "tanh", "atan2", "pow"]) {
    expect(sites[name], name).toEqual([]);
  }
  for (const [name, s] of Object.entries(sites)) expect(s, name).toEqual([]);
});

it("DetMath members are callable from every layer and are deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  writeFileSync(join(dir, "main.ts"), [
    'function r(x: f64): f64 { "use rt"; return DetMath.pow(x, 2) + DetMath.atan2(x, 1); }',
    'function s(x: f64): f64 { "use owned"; return DetMath.log10(x) + DetMath.tanh(x); }',
    "export function m(x: f64): f64 { return r(x) + s(x) + DetMath.sin(x); }",
    "",
  ].join("\n"));
  expect(check(join(dir, "main.ts"))).toEqual([]);
  expect(deterministicFunctions(join(dir, "main.ts"))).toEqual({ r: true, s: true, m: true });
});

it("an unknown DetMath member is E2001 at the member name", () => {
  expect(run({ "main.ts": "export function f(): f64 {\n  return DetMath.sqrt(4);\n}\n" })).toEqual(["E2001 2:18"]);
});

it("DetMath takes f64 only: an f32 argument is an error", () => {
  expect(run({ "main.ts": 'function f(x: f32): f64 {\n  "use rt";\n  return DetMath.sin(x);\n}\n' })).toEqual(["E2002 3:22"]);
});

it("importing the bundled DetMath module is E7001 at the specifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  let spec = relative(dir, DETMATH_PATH);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  writeFileSync(join(dir, "main.ts"), `import { sin } from "${spec}";\nexport function f(x: f64): f64 { return sin(x); }\n`);
  const got = check(join(dir, "main.ts")).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`);
  expect(got).toEqual(["E7001 1:21"]);
});
