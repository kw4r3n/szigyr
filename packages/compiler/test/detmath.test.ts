// Q191 (§12): the DetMath namespace and the bundled module in packages/std/detmath.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { check, deterministicFunctions, rtTrapSites } from "../src/index.ts";
import { DETMATH_PATH } from "../src/detmath.ts";

function run(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  for (const [n, src] of Object.entries(files)) writeFileSync(join(dir, n), src);
  return check(join(dir, "main.szigyr")).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`).sort();
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
  writeFileSync(join(dir, "main.szigyr"), [
    'function r(x: f64): f64 { "use rt"; return DetMath.pow(x, 2) + DetMath.atan2(x, 1); }',
    'function s(x: f64): f64 { "use owned"; return DetMath.log10(x) + DetMath.tanh(x); }',
    "export function m(x: f64): f64 { return r(x) + s(x) + DetMath.sin(x); }",
    "",
  ].join("\n"));
  expect(check(join(dir, "main.szigyr"))).toEqual([]);
  expect(deterministicFunctions(join(dir, "main.szigyr"))).toEqual({ r: true, s: true, m: true });
});

it("an unknown DetMath member is E2001 at the member name", () => {
  expect(run({ "main.szigyr": "export function f(): f64 {\n  return DetMath.sqrt(4);\n}\n" })).toEqual(["E2001 2:18"]);
});

it("DetMath takes f64 only: an f32 argument is an error", () => {
  expect(run({ "main.szigyr": 'function f(x: f32): f64 {\n  "use rt";\n  return DetMath.sin(x);\n}\n' })).toEqual(["E2002 3:22"]);
});

it("importing the bundled DetMath module is E7001 at the specifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  let spec = relative(dir, DETMATH_PATH);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  writeFileSync(join(dir, "main.szigyr"), `import { sin } from "${spec}";\nexport function f(x: f64): f64 { return sin(x); }\n`);
  const got = check(join(dir, "main.szigyr")).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`);
  expect(got).toEqual(["E7001 1:21"]);
});

it("importing the bundled DetMath module through a symlink is E7001 too (Q253)", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-"));
  symlinkSync(DETMATH_PATH, join(dir, "link.szigyr"));
  writeFileSync(join(dir, "main.szigyr"), `import { sin } from "./link.szigyr";\nexport function f(x: f64): f64 { return sin(x); }\n`);
  const got = check(join(dir, "main.szigyr")).map((d) => `${d.code} ${d.range.start.line}:${d.range.start.col}`);
  expect(got).toEqual(["E7001 1:21"]);
});

it("managed DetMath calls run the JS version directly under --backend=c (§12, D117)", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-c-"));
  const managedOnly = join(dir, "managed.szigyr");
  writeFileSync(managedOnly, 'export function main(sys: System): void {\n  sys.log.info(`${DetMath.sin(1)}`);\n}\n');
  const mixed = join(dir, "mixed.szigyr");
  writeFileSync(mixed, [
    'function s(x: f64): f64 { "use owned"; return DetMath.sin(x); }',
    "export function main(sys: System): void {",
    "  sys.log.info(`${DetMath.sin(1)} ${s(1)}`);",
    "}",
    "",
  ].join("\n"));
  const idx = new URL("../src/index.ts", import.meta.url).href;
  const probe = `
    import { run } from ${JSON.stringify(idx)};
    const orig = process.dlopen;
    const calls = [];
    process.dlopen = (m, f, ...r) => {
      orig.call(process, m, f, ...r);
      for (const k of Object.keys(m.exports)) {
        const fn = m.exports[k];
        if (typeof fn === "function" && !["init", "sz_poll", "sz_finish"].includes(k)) { // the runtime exports; functions are sz_F<n>_<name>
          m.exports[k] = (...a) => { calls.push(k); return fn(...a); };
        }
      }
    };
    const out = {};
    for (const [label, file] of [["managed", ${JSON.stringify(managedOnly)}], ["mixed", ${JSON.stringify(mixed)}]]) {
      const rj = await run(file, { backend: "js" });
      calls.length = 0;
      const rc = await run(file, { backend: "c" });
      out[label] = { same: rj.stdout === rc.stdout, calls: [...calls] };
    }
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const res = JSON.parse(r.stdout);
  expect(res.managed).toEqual({ same: true, calls: [] });
  expect(res.mixed.same).toBe(true);
  expect(res.mixed.calls).toEqual(["sz_F0_s"]);
});
